import { main } from "../../resources/doctor-main.js";
import { redactText } from "../../resources/plan.js";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${redactText(message)}\n`);
  process.exit(1);
});
