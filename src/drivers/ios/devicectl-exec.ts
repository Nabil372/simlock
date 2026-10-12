import { type PassthroughCommand, PassthroughRefusedError } from "../../core/index.js";

const TOOL = "devicectl";

const HOST_PATH_LONG_OPTIONS = new Set([
  "--json-output",
  "--log-output",
  "--destination",
  "--file",
  "--filter",
]);

interface CommandSpec {
  readonly positional: number;
  readonly valued: readonly (readonly string[])[];
  readonly flags: readonly string[];
}

const COMMON_VALUED: readonly (readonly string[])[] = [
  ["-d", "--device"],
  ["-t", "--timeout"],
];
const COMMON_FLAGS: readonly string[] = [
  "-v",
  "--verbose",
  "-q",
  "--quiet",
  "--omit-deprecated-fields-in-json",
  "-h",
  "--help",
  "--version",
];

const COMMANDS: ReadonlyMap<string, CommandSpec> = new Map([
  [
    "device install app",
    { flags: ["--hide-default-columns", "--hide-headers"], positional: 1, valued: [["--columns"]] },
  ],
  ["device uninstall app", { flags: [], positional: 1, valued: [] }],
  [
    "device process launch",
    {
      flags: [
        "--start-stopped",
        "--activate",
        "--no-activate",
        "--terminate-existing",
        "--console",
      ],
      positional: 1,
      valued: [
        ["-u", "--user"],
        ["-e", "--environment-variables"],
        ["--working-directory"],
        ["--arch"],
        ["--payload-url"],
        ["--display"],
        ["--launch-persistent-identifier"],
      ],
    },
  ],
  ["device process terminate", { flags: ["--kill"], positional: 0, valued: [["-p", "--pid"]] }],
  [
    "device process signal",
    {
      flags: [],
      positional: 0,
      valued: [
        ["-p", "--pid"],
        ["-s", "--signal"],
      ],
    },
  ],
  [
    "device info apps",
    {
      flags: [
        "--include-app-clips",
        "--no-include-app-clips",
        "--include-removable-apps",
        "--no-include-removable-apps",
        "--include-default-apps",
        "--no-include-default-apps",
        "--include-all-apps",
        "--require-container-access",
        "--include-app-group-identifiers",
        "--include-container-paths",
        "--hide-default-columns",
        "--hide-headers",
      ],
      positional: 0,
      valued: [["--bundle-id"], ["-s", "--search"], ["--sort-by"], ["--columns"]],
    },
  ],
  ["device info lockState", { flags: [], positional: 0, valued: [] }],
  ["device info details", { flags: [], positional: 0, valued: [] }],
  [
    "device info processes",
    {
      flags: ["--hide-default-columns", "--hide-headers"],
      positional: 0,
      valued: [["-s", "--search"], ["--sort-by"], ["--columns"]],
    },
  ],
]);

function refuse(detail: string): never {
  throw new PassthroughRefusedError(
    TOOL,
    `Refusing \`devicectl\` over exec: not allowed over exec: ${detail}`,
  );
}

function isHostPathOption(argument: string): boolean {
  if (argument.startsWith("--")) {
    const name = argument.split("=", 1)[0] ?? argument;
    return HOST_PATH_LONG_OPTIONS.has(name);
  }
  if (argument.startsWith("-") && argument.length > 1) {
    return /[jl]/.test(argument.slice(1));
  }
  return false;
}

function splitOption(argument: string): { readonly name: string; readonly inline: boolean } {
  const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
  return equals === -1
    ? { inline: false, name: argument }
    : { inline: true, name: argument.slice(0, equals) };
}

function isOnList(
  name: string,
  inline: boolean,
  valued: ReadonlySet<string>,
  flags: ReadonlySet<string>,
): boolean {
  return valued.has(name) || (flags.has(name) && !inline);
}

function parseOptions(
  command: string,
  spec: CommandSpec,
  options: readonly string[],
): { readonly namesDevice: boolean } {
  const valued = new Set([...spec.valued, ...COMMON_VALUED].flat());
  const flags = new Set([...spec.flags, ...COMMON_FLAGS]);
  let namesDevice = false;
  let positional = 0;
  let expectsValue = false;
  for (const argument of options) {
    if (expectsValue) {
      expectsValue = false;
      continue;
    }
    if (!argument.startsWith("-") || argument === "-") {
      positional += 1;
      if (positional > spec.positional) {
        refuse(`${command}: ${argument} is an extra argument; the app's own arguments go after --`);
      }
      continue;
    }
    const { name, inline } = splitOption(argument);
    if (!isOnList(name, inline, valued, flags)) {
      refuse(`${command}: ${argument} is not on the reviewed list`);
    }
    if (valued.has(name)) {
      namesDevice ||= name === "-d" || name === "--device";
      expectsValue = !inline;
    }
  }
  if (expectsValue) refuse(`${command}: an option has no value`);
  return { namesDevice };
}

export function devicectlExecCommand(udid: string, args: readonly string[]): PassthroughCommand {
  const separator = args.indexOf("--");
  const before = separator === -1 ? args : args.slice(0, separator);
  for (const argument of before) {
    if (isHostPathOption(argument)) {
      refuse(`${argument} names a path or a predicate on the host`);
    }
  }
  const words = before.slice(0, 3);
  const command = words.join(" ");
  const spec = words.length === 3 ? COMMANDS.get(command) : undefined;
  if (spec === undefined) {
    refuse(
      `${before.length === 0 ? "no command" : before.slice(0, 3).join(" ")} is not on the reviewed list`,
    );
  }
  const { namesDevice } = parseOptions(command, spec, before.slice(3));
  const head = args.slice(0, 3);
  const rest = args.slice(3);
  return {
    args: [TOOL, ...head, ...(namesDevice ? [] : ["--device", udid]), ...rest],
    command: "xcrun",
    env: {},
  };
}
