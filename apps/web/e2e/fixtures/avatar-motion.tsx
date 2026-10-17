import { AgentAvatar } from "@rakazo/ui-web";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
  <AgentAvatar botId="reduced-motion" character="wave" name="Wave" size={64} activity="working" />,
);
