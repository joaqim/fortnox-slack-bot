import { App } from "@slack/bolt";
import Dockerode from "dockerode";
import type { Container, ContainerCreateOptions } from "dockerode";
import { uuid } from "short-uuid";

// https://github.com/chalk/ansi-regex/blob/main/index.js
const ansiRegex = ({ onlyFirst = false } = {}) => {
  const pattern = [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  ].join("|");

  return new RegExp(pattern, onlyFirst ? undefined : "g");
};

const ANSI_REGEX = ansiRegex();
const stripAnsi = (input: string): string => {
  return input.replace(ANSI_REGEX, "");
};

import * as dotenv from "dotenv";

dotenv.config();
const CONTAINER_IMAGE_REPO_TAG = "nushell/nu";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

let docker = new Dockerode();

/**
 * Get env list from running container
 * @param container
 */
const runExec = async (
  container: Container,
  command: string
): Promise<string | undefined> => {
  var options: ContainerCreateOptions = {
    Cmd: ["nu", "-c",  "use /opt/nushell-modules/fortnox_client/ * ; " + command],
    Env: ['PROMPT_INDICATOR=""'],
    AttachStdout: true,
    AttachStderr: true,
  };

  const exec = await container.exec(options);
  const stream = await exec?.start({ hijack: true, stdin: true,  });

  // Initialize the output variable
  let output: Buffer[] = [];

  // Handle data events with explicit utf-8 encoding
  stream.on("data", (chunk: Buffer) => {
    output.push(chunk);
  });

  // Wait for the end event
  await new Promise((resolve) => {
    stream.on("end", resolve);
  });
  if (output?.at(0)) {
    return stripAnsi(
      Uint8Array.prototype.slice.call(output.at(0), 8).toString()
    );
  }
};

const parseCommand = (
  command: string
): {
  ext: string;
  save: boolean;
  filename: string;
  fileExt?: string;
} | null => {
  const pattern = /to\s+(\w+)(?:\s*\|\s*(save)(?:\s+(\w+)(?:\.(\w+)(.*))?)?)?$/;
  const match = command.trim().match(pattern);

  if (!match) {
    return null;
  }
  const ext = match[1];
  if (!ext) {
    return null;
  }

  const save = match[2];
  const filename = match[3] ?? uuid();
  let fileExt = match[4] ?? ext;

  return {
    ext,
    save: save !== undefined,
    filename: `${filename}.${fileExt}`,
    fileExt: fileExt,
  };
};

const escapeSlackSpecialCharacters = (input: string): string => {
  return input.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
};

app.command("/fortnox", async ({ command, ack, say }) => {
  await ack();

  // Extract command parameters
  let commandToExecute = command.text.trim();

  const meta = parseCommand(commandToExecute);

  // We override nu's '| save {filename}' command, here we simply remove it after parsing it
  if (meta?.save) {
    commandToExecute = commandToExecute
      .slice(0, commandToExecute.lastIndexOf("|"))
      .trimEnd();
  }

  // Create a Docker container
  const container = await docker.createContainer({
    Image: CONTAINER_IMAGE_REPO_TAG,
    //Entrypoint: ['/usr/bin/nu'],
    Tty: true,
  });

  try {
    // Start the Docker container
    await container.start();
    console.log({ commandToExecute });
    // Wait for the container to finish
    const output = await runExec(container, commandToExecute);

    if (output) {
      if (output.startsWith("Error: ")) {
        throw new Error(output);
      }
      if (meta?.save) {
        const uploadResult = await app.client.files.uploadV2({
          channels: command.channel,
          content: output,
          filename: meta.filename,
          title: `${meta.filename}`,
        });

        if (uploadResult.error) {
          say("Failed to upload file");
        } else {
          const file = (uploadResult.files as any).at(0).files.at(0);
          say(`<${file.permalink}|${file.title ?? file.name}>`);
        }
      } else {
        if (meta?.ext) {
          say({
            text: escapeSlackSpecialCharacters(output),
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  //text: `\`\`\`${meta.ext}\n${output}\n\`\`\``,
                  text: `\`\`\`\n${output}\n\`\`\``,
                },
              },
            ],
          });
        } else {
          say(`\`\`\`${escapeSlackSpecialCharacters(output)}\`\`\``);
        }
      }
    }
  } catch (error) {
    const { message } = error as Error;
    say(`\`\`\`\n${message}\n\`\`\``);
  } finally {
    // Remove the container (cleanup)
    try {
      await container.exec({Cmd: ['exit 0']})
    } finally {
      await container.stop();
      container.remove();
    }
  }
});

app.event("app_mention", async ({ event, say }) => {
  console.log({ event });
  say("I was mentioned!");
});

(async () => {
  await app.start();
  console.log("⚡️ Bolt app started");
})();
