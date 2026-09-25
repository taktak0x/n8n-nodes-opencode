import { OpenCodeAcpClient } from "../nodes/LmChatOpenCode/OpenCodeAcpClient";

const runAcpIntegration = process.env.RUN_ACP_INTEGRATION === "true";
const acpExecutable = process.env.ACP_EXECUTABLE;
const acpModel = process.env.ACP_MODEL;
const acpCwd = process.env.ACP_CWD ?? "/tmp";
const acpConfigured = runAcpIntegration && acpExecutable && acpModel;

if (!acpConfigured) {
  console.warn(
    "Skipping ACP integration test: set RUN_ACP_INTEGRATION=true, ACP_EXECUTABLE, and ACP_MODEL",
  );
}

const describeAcp = acpConfigured ? describe : describe.skip;

describeAcp("OpenCode ACP integration", () => {
  it("returns text and cleans up its ACP process", async () => {
    const separator = acpModel!.indexOf("/");
    if (separator <= 0 || separator === acpModel!.length - 1) {
      throw new Error("ACP_MODEL must use provider/model format");
    }

    const client = new OpenCodeAcpClient({
      acpExecutable: acpExecutable!,
      providerID: acpModel!.slice(0, separator),
      modelID: acpModel!.slice(separator + 1),
      cwd: acpCwd,
      timeoutMs: 120000,
    });

    const response = await client.prompt(
      'Reply with exactly "ACP_SMOKE_OK" and nothing else.',
    );

    expect(response.trim()).toBe("ACP_SMOKE_OK");
    expect((client as unknown as { process?: unknown }).process).toBeUndefined();
  }, 150000);
});
