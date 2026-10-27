import { readComponents, repository } from "../verification/catalog";
import { ciWorkflow } from "../verification/ci-model";
import { ciMessages } from "./ci.messages";

const path = `${repository}/.github/workflows/ci.yml`;
await Bun.write(
  path,
  ciMessages.generatedHeader + Bun.YAML.stringify(ciWorkflow(await readComponents())),
);
const formatter = Bun.spawn([process.execPath, "--bun", "prettier", "--write", path], {
  cwd: repository,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await formatter.exited;
