import { execa } from 'execa';

async function main(): Promise<void> {
  console.log("Running deterministic quality audit...");
  await execa('npm', ['run', 'build'], { stdout: 'inherit', stderr: 'inherit' });
  await execa('npm', ['test'], { stdout: 'inherit', stderr: 'inherit' });
  console.log("PASSED");
}

main().catch(() => {
  console.log("FAILED");
  process.exit(1);
});
