// 编程套餐直通 · 配置面板
// channel 与 src/ui/ipc.ts 对应：插件侧注册短名，框架命名空间化为
// plugin:coding-plan-gate:<channel>，这里用完整名 invoke。
// 安全约定：面板绝不显示订阅 Key 本身，只显示「有没有配」。
const { ipcRenderer } = require("electron");

const GET_STATE = "plugin:coding-plan-gate:get-state";
const SAVE_CONFIG = "plugin:coding-plan-gate:save-config";
const SAVE_KEY = "plugin:coding-plan-gate:save-key";
const CLEAR_KEY = "plugin:coding-plan-gate:clear-key";

const $ = (id) => document.getElementById(id);

let state = null;

function renderGate(gate) {
  const badge = $("gate-badge");
  if (gate && gate.open) {
    badge.textContent = "开窗中";
    badge.className = "badge on";
  } else {
    badge.textContent = "已关闭";
    badge.className = "badge off";
  }
}

function renderPlans(plans, config) {
  const select = $("plan");
  select.textContent = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "（未选择）";
  select.appendChild(empty);
  for (const plan of plans) {
    const option = document.createElement("option");
    option.value = plan.id;
    option.textContent = plan.label;
    if (plan.id === config.planId) option.selected = true;
    select.appendChild(option);
  }
  renderTerms(plans, config.planId);
}

function renderTerms(plans, planId) {
  const node = $("terms");
  node.textContent = "";
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return;
  const span = document.createElement("span");
  span.textContent = `Key 前缀应为 ${plan.keyPrefix}。使用前请自行复核条款：`;
  const link = document.createElement("a");
  link.href = plan.termsUrl;
  link.textContent = plan.termsUrl;
  link.target = "_blank";
  node.appendChild(span);
  node.appendChild(link);
}

function render(next) {
  state = next;
  renderGate(next.gate);
  renderPlans(next.plans, next.config);
  $("ttl").value = next.config.windowTtlMs;

  const keyState = $("key-state");
  keyState.textContent = next.keyConfigured ? "已配置" : "未配置";
  keyState.className = next.keyConfigured ? "badge on" : "badge off";

  $("base-url").textContent = next.proxy ? next.proxy.baseUrl : "代理未运行";
  $("token").textContent = next.proxy ? next.proxy.token : "—";
}

async function refresh() {
  try {
    render(await ipcRenderer.invoke(GET_STATE));
  } catch (err) {
    $("gate-note").textContent = `读取状态失败：${String(err)}`;
  }
}

$("plan").addEventListener("change", async (event) => {
  const result = await ipcRenderer.invoke(SAVE_CONFIG, { planId: event.target.value });
  if (result && result.ok) await refresh();
});

$("save-config").addEventListener("click", async () => {
  const ttl = Number($("ttl").value);
  const result = await ipcRenderer.invoke(SAVE_CONFIG, { windowTtlMs: ttl });
  if (result && result.ok) await refresh();
});

$("save-key").addEventListener("click", async () => {
  const key = $("key").value;
  if (!key) return;
  const planId = $("plan").value;
  const result = await ipcRenderer.invoke(SAVE_KEY, { planId, key });
  $("key").value = "";
  if (result && result.ok && result.prefixMismatch) {
    $("key-state").textContent = `已保存（前缀不是 ${result.expectedPrefix}，确认没贴成按量付费 Key）`;
  }
  await refresh();
});

$("clear-key").addEventListener("click", async () => {
  await ipcRenderer.invoke(CLEAR_KEY, $("plan").value);
  await refresh();
});

void refresh();
// 闸门状态随轮次变化，轮询刷新即可，不值得为它加一条推送通道。
setInterval(() => {
  void refresh();
}, 3000);
