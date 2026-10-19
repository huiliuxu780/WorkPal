import { AgentAvatar } from "@rakazo/ui-web";
import { createRoot } from "react-dom/client";

const size = new URLSearchParams(location.search).get("size") === "16" ? 16 : 64;

createRoot(document.getElementById("root")!).render(
  <AgentAvatar
    botId="reduced-motion"
    character="wave"
    name="Wave"
    size={size}
    activity="working"
  />,
);
