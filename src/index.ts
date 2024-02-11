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
    User: "slackbot",
    //Cmd: ["nu", "-c", "source ~/config.nu ; fortnox " + command],
    Cmd: [
      "nu",
      "-c",
      "source ~/.config/nushell/env.nu ; source ~/.config/nushell/config.nu ; fortnox " +
        command,
    ],
    AttachStdout: true,
    AttachStderr: true,
  };

  const exec = await container.exec(options);
  const stream = await exec?.start({ hijack: true, stdin: true });

  // Initialize the output variable
  let output: Buffer[] = [];

  // Collect data events as buffers ("utf-8" encoded)
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

const parseOptionalSaveCommand = (
  command: string,
  fortnoxResource?: string
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
  const filename = match[3] ?? fortnoxResource ?? uuid();
  let fileExt = match[4] ?? ext;

  return {
    ext,
    save: save !== undefined,
    filename: `${filename}`,
    fileExt: fileExt,
  };
};

const escapeSlackSpecialCharacters = (input: string): string => {
  return input.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
};

app.event("app_home_opened", async ({ event, context }) => {
  const yourView = {
    type: "home",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "This is a mrkdwn section block :ghost: *this is bold*, and ~this is crossed out~, and <https://google.com|this is a link>",
        },
      },
    ],
  };
  const result = await app.client.views.publish({
    user_id: event.user,
    view: {
      type: "home",
      callback_id: "home_view",
      blocks: [
        {
          dispatch_action: true,
          type: "input",
          element: {
            type: "plain_text_input",
            action_id: "findus_submit",
          },
          label: {
            type: "plain_text",
            text: "Label",
            emoji: false,
          },
        },
      ],
    },
  });
  console.log({ result });
});

app.view("findus_submit", async ({ ack, body, view, client }) => {
  await ack();
  // Process the submitted data
  const submittedData = view.state.values;

  client.views.update({
    view: {
      type: "home",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: JSON.stringify(submittedData, null, 2),
          },
        },
      ],
    },
  });
  console.log({ submittedData });
});
/* app.client.views.update({
  view: {
    type: "home" ,
  }
})
 */
app.command("plain_text_input-action", async ({ command, ack, say }) => {
  ack();
  console.log(JSON.stringify(command, null, 2));
  say(`Hello, <@${command.user_id}>!`);
});

app.command("/fortnox", async ({ command, ack, say }) => {
  ack();
  console.log(JSON.stringify(command, null, 2));

  // Extract command parameters
  let commandToExecute = command.text.trim();

  const fortnoxResource = commandToExecute.match(/^(\w+)\s/)?.[1];
  if (
    !["invoices", "-h", "version"].includes(fortnoxResource ?? commandToExecute)
  ) {
    say("```Unsupported fortnox resource: '" + fortnoxResource + "'```");
    return;
  }

  if (commandToExecute.indexOf(";") != -1) {
    commandToExecute = commandToExecute
      .slice(0, commandToExecute.indexOf(";"))
      .trimEnd();
  }

  if (/\$env/.test(commandToExecute)) {
    say("```Using environment variables is not supported```");
    return;
  }

  if (/\.env.nu/.test(commandToExecute)) {
    say("```Not allowed to access .env.nu files```");
    return;
  }

  if (/\^\w+/.test(commandToExecute)) {
    say("```Not allowed to use ^ core override commands```");
    return;
  }

  const meta = parseOptionalSaveCommand(commandToExecute, fortnoxResource);

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
        if (meta.filename == "invoice") {
          let id = output.match(/"DocumentNumber":\s*(\d+),/)?.[1];
          if (id) meta.filename + "-" + id;
        }
        const uploadResult = await app.client.files.uploadV2({
          channels: command.channel,
          content: output,
          filename: `${meta.filename}.${meta.fileExt}`,
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
                  text: `\`\`\`\n${escapeSlackSpecialCharacters(
                    output
                  )}\n\`\`\``,
                },
              },
              /* {
                type: "rich_text",
                elements: [
                  {
                    type: "rich_text_preformatted",
                    elements: [
                      {
                        type: "text",
                        text: output,
                      },
                    ],
                  },
                ],
              }, */
            ],
          });
        } else {
          say(`\`\`\`\n${escapeSlackSpecialCharacters(output)}\`\`\``);
        }
      }
    }
  } catch (error) {
    const { message } = error as Error;
    say(`\`\`\`\n${message}\n\`\`\``);
  } finally {
    // Remove the container (cleanup)
    try {
      await container.exec({ Cmd: ["exit 0"] });
    } finally {
      try {
        await container.stop();
        container.remove();
      } catch {}
    }
  }
});

(async () => {
  await app.start();
  console.log("⚡️ Bolt app started");
})();
