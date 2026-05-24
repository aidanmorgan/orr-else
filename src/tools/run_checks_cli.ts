import { execFileSync } from 'child_process';

try {
  console.log("Running deterministic quality audit...");
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  execFileSync('npm', ['test'], { stdio: 'inherit' });
  console.log("PASSED");
} catch (error) {
  console.log("FAILED");
  process.exit(1);
}
