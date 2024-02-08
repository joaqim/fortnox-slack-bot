import { App } from "@slack/bolt";
import Dockerode from "dockerode";
import type { Container, ContainerCreateOptions } from "dockerode";
import { uuid } from "short-uuid";

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
    Cmd: ["nu", "-c", command],
    Env: ['PROMPT_INDICATOR=""'],
    AttachStdout: true,
    AttachStderr: true,
  };

  const exec = await container.exec(options);
  const stream = await exec?.start({ hijack: true, stdin: true });

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
    return Uint8Array.prototype.slice.call(output.at(0), 8).toString();
  }
};
const removeANSIColors = (input: string): string => {
  // Regular expression to match ANSI color codes
  const ansiColorRegex = /\x1B\[[0-9;]*[mGK]/g;

  // Remove ANSI color codes from the input string
  return input.replace(ansiColorRegex, "");
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
    Tty: true,
  });

  try {
    // Start the Docker container
    await container.start();
    console.log({ commandToExecute });
    // Wait for the container to finish
    const output = await runExec(container, commandToExecute);

    if (output) {
      if (meta?.save) {
        const uploadResult = await app.client.files.uploadV2({
          channels: command.channel,
          content: output,
          filename: meta.filename,
          title: `${meta.fileExt} File`,
        });

        if (uploadResult.error) {
          say("Failed to upload file");
        } else {
          const file = (uploadResult.files as any).at(0).files.at(0);
          say(`<${file.permalink}|${file.title ?? file.name}>`);
        }
      } else {
        if (meta?.ext) {
          say(`\`\`\`${meta.ext}\n${output}\`\`\``);
        } else {
          say(`\`\`\`${output}\`\`\``);
        }
      }
    }
  } catch (error) {
    const { message } = error as Error;
    say(`Failed to execute: '${command.text}' - ${message}`);
  } finally {
    // Remove the container (cleanup)
    await container.stop();
    container.remove();
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
