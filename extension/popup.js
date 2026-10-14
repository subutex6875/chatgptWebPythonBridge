document.getElementById("version").textContent = `Extension version ${chrome.runtime.getManifest().version}`;

const status = document.getElementById("status");
const refresh = document.getElementById("refresh");

async function checkConnection() {
  status.textContent = "Checking local bridge…";
  status.className = "";
  try {
    const result = await chrome.runtime.sendMessage({ type: "BRIDGE_HEALTH" });
    if (result?.ok) {
      const queued = Number(result.data?.queued ?? 0);
      status.textContent = `Connected. ${queued} queued job${queued === 1 ? "" : "s"}.`;
      status.className = "online";
    } else {
      status.textContent = `Cannot reach the Python bridge. Start it with: python bridge.py\n${result?.error || ""}`;
      status.className = "offline";
    }
  } catch (error) {
    status.textContent = `Cannot reach the Python bridge. Start it with: python bridge.py\n${error.message}`;
    status.className = "offline";
  }
}

refresh.addEventListener("click", checkConnection);
checkConnection();
