"use strict";

const $ = (id) => document.getElementById(id);
const config = window.TRIAL_CONFIG || {};
const labels = { sheet: "phiếu Google Sheets", json: "JSON", photo: "ảnh" };
let googleClient;
let accessToken = "";
let expiresAt = 0;
let account;
let record;
let nextAdminAction;
let editVersion;
let busy = false;
let timer;

function notice(message, error = false) {
  $("message").textContent = message;
  $("message").classList.toggle("error", error);
  $("message").hidden = !message;
}

function reset() {
  clearTimeout(timer);
  accessToken = "";
  expiresAt = 0;
  account = null;
  record = null;
  editVersion = null;
  $("workspace").hidden = true;
  $("logout").hidden = true;
  $("entry").hidden = false;
  $("email").textContent = "";
  $("employeeEmail").textContent = "";
  clearStation();
}

function clearStation() {
  record = null;
  editVersion = null;
  $("survey").hidden = true;
  $("progress").hidden = true;
  $("stationName").textContent = "";
  $("surveyForm").reset();
}

function authenticated() {
  if (accessToken && Date.now() < expiresAt) return true;
  reset();
  notice("Phiên Google đã hết hạn. Vui lòng đăng nhập lại.", true);
  return false;
}

function buttons() {
  $("login").disabled = busy || !googleClient;
  for (const id of ["logout", "refresh", "assignAction", "save"]) $(id).disabled = busy;
}

async function run(action) {
  if (busy) return;
  busy = true;
  buttons();
  try {
    await action();
  } catch (error) {
    notice(error.message || "Yêu cầu chưa hoàn tất. Vui lòng làm mới để kiểm tra.", true);
  } finally {
    busy = false;
    buttons();
  }
}

async function api(request) {
  if (!authenticated()) throw new Error("Phiên Google đã hết hạn. Vui lòng đăng nhập lại.");
  const url = "https://script.googleapis.com/v1/scripts/" + encodeURIComponent(config.deploymentId) + ":run";
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 45000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ function: "trialApi", parameters: [request] }),
      credentials: "omit",
      cache: "no-store",
      signal: abort.signal
    });
    if (response.status === 401) {
      reset();
      throw new Error("Google yêu cầu đăng nhập lại.");
    }
    const data = await response.json();
    if (!response.ok || data.error) {
      const detail = data.error?.details?.find((entry) => entry.errorMessage)?.errorMessage;
      throw new Error(detail || data.error?.message || "Google chưa xác nhận thao tác.");
    }
    if (!data.done || !data.response || !data.response.result) {
      throw new Error("Chưa nhận được kết quả từ Apps Script. Hãy bấm Làm mới để kiểm tra.");
    }
    return data.response.result;
  } catch (error) {
    if (error.name === "AbortError" || error instanceof TypeError) {
      throw new Error("Kết nối bị ngắt. Hãy làm mới để kiểm tra kết quả trước khi thử lại.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function showAccount(me) {
  account = me;
  $("entry").hidden = true;
  $("workspace").hidden = false;
  $("logout").hidden = false;
  $("email").textContent = me.email;
  $("access").textContent = me.role === "admin" ? "Quản trị viên" : "Nhân viên khảo sát";
  $("admin").hidden = me.role !== "admin";
  const employee = me.employee;
  if (me.role === "admin" && employee) {
    $("employeeEmail").textContent = employee.email;
    $("employeeAccess").textContent = employee.assigned ? "Đã nhận trạm thử." :
      employee.approved ? "Đã duyệt, đang chờ giao trạm." :
      employee.requested ? "Đã yêu cầu cấp quyền, đang chờ duyệt." : "Chờ nhân viên đăng nhập lần đầu.";
    $("assignAction").hidden = !employee.requested;
    nextAdminAction = employee.assigned ? "unassign" : employee.approved ? "assign" : "approve";
    $("assignAction").textContent = { unassign: "Thu hồi trạm", assign: "Giao trạm thử", approve: "Duyệt nhân viên" }[nextAdminAction];
  }
  $("empty").hidden = me.stations.length > 0;
  if (!me.stations.length) {
    clearStation();
    $("emptyTitle").textContent = me.approved ? "Chưa được giao trạm" : "Đang chờ duyệt";
    $("emptyHint").textContent = me.approved ?
      "Khi quản trị viên giao trạm, bấm Làm mới để mở phiếu." :
      "Khi quản trị viên duyệt tài khoản, bấm Làm mới để xem trạng thái.";
  }
}

function presentStation(next, updateInputs) {
  record = next;
  $("survey").hidden = false;
  $("progress").hidden = false;
  $("stationName").textContent = next.stationId;
  if (updateInputs) {
    editVersion = next.version;
    $("height").value = next.heightM ?? "";
    $("photo").checked = false;
  }
  $("fixture").hidden = Boolean(next.photoId);
  $("existingPhoto").hidden = !next.photoId;
  $("savedVersion").textContent = next.version ? "Bản " + next.version : "Chưa lưu";
  $("driveVersion").textContent = next.syncVersion ? "Bản " + next.syncVersion : "Chưa xác nhận";
  $("queued").textContent = String(next.queued);
  if (next.queued) {
    $("syncHint").textContent = "Đã nhận trên máy chủ. Anh có thể đóng trang và mở lại để kiểm tra Drive.";
  } else {
    $("syncHint").textContent = next.version && next.version === next.syncVersion ?
      "Drive đã xác nhận bản mới nhất." : "";
  }
}

function startTimer() {
  clearTimeout(timer);
  if (!record?.queued || !accessToken) return;
  timer = setTimeout(async () => {
    if (busy || document.hidden) {
      startTimer();
      return;
    }
    await run(() => refresh(false));
  }, 25000);
}

async function refresh(updateInputs = true) {
  clearTimeout(timer);
  const me = await api({ action: "me" });
  showAccount(me);
  if (!me.stations.length) return;
  const stationId = me.stations[0].id;
  try {
    const next = await api({ action: "read", stationId });
    const concurrent = editVersion !== null && next.version !== editVersion;
    presentStation(next, updateInputs || editVersion === null);
    if (concurrent && !updateInputs) {
      notice("Phiếu đã được cập nhật ở phiên khác. Bấm Làm mới để xem bản mới nhất.");
    }
  } catch (error) {
    clearStation();
    throw error;
  }
  startTimer();
}

async function save() {
  if (!record || !$("surveyForm").reportValidity()) return;
  const request = {
    action: "save",
    stationId: record.stationId,
    expectedVersion: editVersion,
    heightM: $("height").valueAsNumber
  };
  if (!record.photoId && $("photo").checked) request.photoId = "sample-01";
  const next = await api(request);
  presentStation(next, true);
  notice(next.noop ? "Phiếu không đổi. Không tạo lượt đồng bộ mới." :
    "Đã lưu bản " + next.version + ". Phần cần đồng bộ gồm " + next.changed.map((key) => labels[key]).join(", ") + ".");
  startTimer();
}

function startLogin() {
  if (busy || !googleClient) return;
  busy = true;
  buttons();
  notice("");
  try {
    googleClient.requestAccessToken({ prompt: "select_account" });
  } catch {
    busy = false;
    buttons();
    notice("Trình duyệt chưa mở được cửa sổ đăng nhập Google.", true);
  }
}

$("login").addEventListener("click", startLogin);
$("logout").addEventListener("click", () => {
  reset();
  notice("");
  startLogin();
});
$("refresh").addEventListener("click", () => run(async () => {
  notice("");
  await refresh();
}));
$("assignAction").addEventListener("click", () => run(async () => {
  if (account?.role !== "admin") return;
  const action = nextAdminAction;
  showAccount(await api({ action }));
  notice({ unassign: "Đã thu hồi quyền truy cập trạm.", assign: "Đã giao trạm thử.", approve: "Đã duyệt nhân viên." }[action]);
}));
$("surveyForm").addEventListener("submit", (event) => {
  event.preventDefault();
  run(save);
});

function setup() {
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(config.googleClientId) ||
      !/^[\w-]+$/.test(config.deploymentId || "")) {
    $("setup").textContent = "Trang thử chưa được kết nối với Google OAuth và Apps Script.";
    return;
  }
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.onload = () => {
    googleClient = google.accounts.oauth2.initTokenClient({
      client_id: config.googleClientId,
      scope: "https://www.googleapis.com/auth/userinfo.email",
      include_granted_scopes: false,
      callback: (response) => {
        busy = false;
        buttons();
        if (response.error || !response.access_token) {
          notice("Google chưa cấp quyền đăng nhập cho phiên này.", true);
          return;
        }
        accessToken = response.access_token;
        expiresAt = Date.now() + Number(response.expires_in) * 1000 - 5000;
        run(() => refresh());
      },
      error_callback: () => {
        busy = false;
        buttons();
        notice("Phiên chọn tài khoản chưa hoàn tất. Anh có thể đăng nhập lại.");
      }
    });
    buttons();
  };
  script.onerror = () => { $("setup").textContent = "Chưa tải được dịch vụ đăng nhập Google. Hãy tải lại trang."; };
  document.head.append(script);
}
setup();
