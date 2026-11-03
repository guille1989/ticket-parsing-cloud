import { execFileSync } from "node:child_process";

/** Outputs del stack de CloudFormation (nombres de tablas, workgroup...) leídos con la AWS CLI. */
export function readStackOutputs(stackName: string = "TicketParsingCloudStack", region: string = "us-east-1"): Record<string, string> {
  const raw = execFileSync(
    "aws",
    ["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region, "--query", "Stacks[0].Outputs", "--output", "json"],
    { encoding: "utf-8", shell: process.platform === "win32" },
  );
  return Object.fromEntries((JSON.parse(raw) as Array<{ OutputKey: string; OutputValue: string }>).map((o) => [o.OutputKey, o.OutputValue]));
}

export function requireOutput(outputs: Record<string, string>, name: string): string {
  if (!outputs[name]) throw new Error(`el stack no tiene el output ${name}`);
  return outputs[name];
}
