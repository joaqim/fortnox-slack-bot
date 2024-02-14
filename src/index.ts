import {
  App,
  BlockAction,
  FileBlock,
  PlainTextInputAction,
  SayArguments,
  SayFn,
  SectionBlock,
  UploadedFile,
  ViewErrorsResponseAction,
} from "@slack/bolt";
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
    Cmd: ["nu", "--config ~/.config/nushell/config.nu", "-c", command],
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
  if ((output?.length ?? 0) > 0) {
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
  const pattern =
    /(?:\s|\|)?to\s+(\w+)(?:\s*\|\s*(save)(?:\s+(\w+)(?:\.(\w+)(.*))?)?)?$/;
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
            multiline: true,
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

app.action<BlockAction<PlainTextInputAction>>(
  "findus_submit",
  async ({ ack, client, action, body, context }) => {
    await ack();
    const ALWAYS_CLEAR_PREVIOUS_RESPONSES = false;
    // Retrieve the original view ID from the action payload
    const viewId = body?.view?.id;

    // Retrieve the current view state
    const currentView = body.view!;
    const say = async (message: string | SayArguments): Promise<any> => {
      // Create an additional section to be added to the view
      const additionalSection: SectionBlock | FileBlock =
        typeof message == "string"
          ? {
              type: "section",
              text: {
                type: "mrkdwn",
                text: message,
              },
            }
          : (message.blocks!.at(1) as FileBlock);

      // Update the original view by adding the additional section
      const updatedView = {
        view_id: viewId,
        hash: currentView.hash,
        view: {
          type: currentView.type as "home",
          blocks:
            ALWAYS_CLEAR_PREVIOUS_RESPONSES || action.value == "clear"
              ? [currentView.blocks.at(0)!, additionalSection]
              : [
                  currentView.blocks.at(0)!,
                  additionalSection,
                  ...currentView.blocks.slice(1)!,
                ],
        },
      };
      console.log(JSON.stringify(updatedView, null, 2));

      // Call the views.update method to update the view
      try {
        await client.views.update(updatedView);
      } catch (error) {
        console.error(
          "Error updating view:",
          error,
          JSON.stringify(
            (error as { data: ViewErrorsResponseAction }).data,
            null,
            2
          )
        );
      }
    };
    await execFortnoxCommand(
      action.value,
      say,
      body.channel?.id ?? body.channel?.name
    );
  }
);

const execFortnoxCommand = async (
  commandToExecute: string,
  say: SayFn,
  channel_id?: string
) => {
  const fortnoxResourceOrCommand: string =
    commandToExecute.match(/^\s*(\w+)/)?.[1] ?? "";
  let fortnoxResource: string | undefined;
  console.log({ fortnoxResourceOrCommand });
  if (/invoices|version/.test(fortnoxResourceOrCommand)) {
    fortnoxResource = fortnoxResourceOrCommand;
    if (!/^\s*fortnox/.test(commandToExecute)) {
      commandToExecute = "fortnox " + commandToExecute;
    }
  }
  /*
  else if (!/let|fortnox/.test(fortnoxResourceOrCommand ?? "")) {
    await say(
      "```Unexpect command: '" +
        fortnoxResourceOrCommand +
        "'\nUse 'invoices -h' for help```"
    );
    return;
  }
  */

  // Replace newlines in valid nushell multilines with ';'
  const regex = /([^{|(])(\s*\n+\s*[^|])/g;
  commandToExecute = commandToExecute.replaceAll(regex, (_, group1, group2) => {
    if (group2.trim().length === 0) {
      return group1;
    }
    return group1 + ";" + group2;
  });

  const ALLOW_MULTILINE_COMMANDS = true;
  if (!ALLOW_MULTILINE_COMMANDS && commandToExecute.indexOf(";") != -1) {
    commandToExecute = commandToExecute
      .slice(0, commandToExecute.indexOf(";"))
      .trimEnd();
  }

  if (/\$env/.test(commandToExecute)) {
    await say("```Using environment variables is not supported```");
    return;
  }

  if (/\.env.nu/.test(commandToExecute)) {
    await say("```Not allowed to access .env.nu files```");
    return;
  }

  if (/\^\w+/.test(commandToExecute)) {
    await say("```Not allowed to use ^ core override commands```");
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
        if (fortnoxResource == "invoices") {
          let id = output.match(/"?DocumentNumber"?:?\s*"?(\d+)"?/gm)?.[1];
          //if (id) meta.filename + "-" + id;
          if (id) meta.filename = fortnoxResource + "-" + id;
        }
        const uploadResult = await app.client.files.uploadV2({
          channel_id: channel_id ?? "C06HS8JP77F",
          content: output.trimEnd(),
          filename: `${meta.filename}.${meta.fileExt}`,
          filetype: `${meta.fileExt}`,
        });
        if (uploadResult.error) {
          await say("Failed to upload file");
        } else {
          const file = (uploadResult.files as any[])
            .at(0)!
            .files.at(0) as UploadedFile;

          // Don't print the file link when we are in a channel; the file upload creates a link
          // automatically
          if (!channel_id) {
            const fileLink = `<${file.permalink}|${file.title ?? file.name}>`;
            await say(fileLink);
          }
        }
      } else {
        await say(`\`\`\`\n${escapeSlackSpecialCharacters(output)}\`\`\``);
      }
    }
  } catch (error) {
    const { message } = error as Error;
    if (typeof message == "string") {
      await say(`\`\`\`\n${escapeSlackSpecialCharacters(message)}\n\`\`\``);
    } else {
      await say(
        `\`\`\`\n${escapeSlackSpecialCharacters(
          (message as string[]).join("\\n")
        )}\n\`\`\``
      );
    }
  } finally {
    // Remove the container (cleanup)
    try {
      await container.stop();
      container.remove();
    } catch {}
  }
};

app.command("/fortnox", async ({ command, ack, say }) => {
  await ack();
  execFortnoxCommand(command.text.trim(), say, command.channel_id);
});

(async () => {
  await app.start();
  console.log("⚡️ Bolt app started");
})();
