import { appendFileSync } from "node:fs";
import { buildArtifact, requiredArtifacts } from "../verification/catalog";
import { artifactName } from "./artifacts-metadata";
import { ciMessages } from "./ci.messages";

const [component, task, target] = process.argv.slice(2);
const sha = process.env.GITHUB_SHA;
const output = process.env.GITHUB_OUTPUT;
if (!component || !task || !target || !sha || !output) {
  throw new Error(ciMessages.consumerArguments);
}
const names = Object.fromEntries(
  requiredArtifacts(component, task).map((id) => {
    const artifact = buildArtifact(id);
    return [id, artifactName(artifact, target, sha)];
  }),
);
appendFileSync(output, `artifacts=${JSON.stringify(names)}\n`);
