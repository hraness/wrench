import { expect, test } from "bun:test";
import { join } from "node:path";

test("messaging client reaps owned process trees before private cleanup", async () => {
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "messaging-client-process.fixture.ts"),
  ], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const exitCode = await Promise.race([
    child.exited,
    new Promise<number>((resolve) => {
      deadline = setTimeout(() => {
        child.kill();
        resolve(-1);
      }, 10_000);
    }),
  ]);
  if (deadline !== undefined) clearTimeout(deadline);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
