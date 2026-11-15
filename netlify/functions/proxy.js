"use strict";

const crypto = require("crypto");

const DEFAULT_BASE = "https://dashscope.aliyuncs.com/api/v1";
const DEFAULT_MODEL = "wan2.5-i2i-preview";
const MAX_BODY_CHARS = 2000000; // 约 2 MB base64，压到这里 POST 才能在 2-3 秒内完成
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5000; // 单次提交/查询最多 5 秒，留出 Netlify 10 秒余量

function headersFor(event) {
  const allowed = String(process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const origin = event.headers && (event.headers.origin || event.headers.Origin);
  let allowOrigin = "";

  if (allowed.length > 0) {
    if (origin && allowed.includes(origin)) allowOrigin = origin;
  } else if (origin) {
    const host = (event.headers && (event.headers.host || event.headers.Host)) || "";
    try {
      if (host && new URL(origin).host === host) allowOrigin = origin;
    } catch (_) {
      // ignore
    }
  }

  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };

  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, X-App-Token";
  }

  return headers;
}

function respond(event, statusCode, payload) {
  return {
    statusCode,
    headers: headersFor(event),
    body: JSON.stringify(payload),
  };
}

function ok(event, payload = {}) {
  return respond(event, 200, { ok: true, ...payload });
}

/**
 * 所有“可预期”的错误都走 HTTP 200 + ok:false。
 * 这样前端永远能拿到具体原因，不会只看到 502。
 */
function handledError(event, code, message, extra = {}) {
  return respond(event, 200, {
    ok: false,
    error: { code, message, ...extra },
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 按原图比例算输出尺寸，满足万相约束：
 * 总像素 768*768 ~ 1280*1280，宽高比 1:4 ~ 4:1，单边 384 ~ 5000
 */
function computeSize(width, height) {
  let w = Number(width);
  let h = Number(height);

  if (!Number.isFinite(w) || w <= 0) w = 1024;
  if (!Number.isFinite(h) || h <= 0) h = 1024;

  w = clamp(w, 384, 5000);
  h = clamp(h, 384, 5000);

  const ratio = w / h;
  if (ratio > 4) w = h * 4;
  if (ratio < 0.25) h = w * 4;

  const target = 1024 * 1024;
  const scale = Math.sqrt(target / (w * h));
  let outW = Math.round(w * scale);
  let outH = Math.round(h * scale);

  outW = clamp(outW, 384, 5000);
  outH = clamp(outH, 384, 5000);

  let total = outW * outH;
  if (total < 768 * 768) {
    const s = Math.sqrt((768 * 768) / total);
    outW = Math.round(outW * s);
    outH = Math.round(outH * s);
  }
  total = outW * outH;
  if (total > 1280 * 1280) {
    const s = Math.sqrt((1280 * 1280) / total);
    outW = Math.round(outW * s);
    outH = Math.round(outH * s);
  }

  return `${outW}*${outH}`;
}

function normalizeImage(input) {
  let image = String(input || "").trim();
  if (!image) return null;

  if (!image.startsWith("data:")) {
    image = "data:image/jpeg;base64," + image.replace(/\s+/g, "");
  }

  const match = image.match(
    /^data:(image\/(?:jpeg|jpg|png|webp|bmp));base64,([A-Za-z0-9+/=\s]+)$/i
  );
  if (!match) return null;

  const mime = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  const data = match[2].replace(/\s+/g, "");
  const bytes = Buffer.byteLength(data, "base64");
  if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) return null;

  return `data:${mime};base64,${data}`;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const request = fetch(url, { ...options, signal: controller.signal });
  // 防止 race 输掉后出现未处理的 rejection
  request.catch(() => {});

  let deadlineTimer;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      const error = new Error("request timeout");
      error.name = "TimeoutError";
      reject(error);
    }, REQUEST_TIMEOUT_MS);
  });

  try {
    // 双保险：即使 abort 没及时生效，也会在 5 秒时把控制权交回函数
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(deadlineTimer);
  }
}

function upstreamError(event, stage, status, json, text) {
  const code = (json && json.code) || "dashscope_error";
  const message =
    (json && json.message) || String(text || "").slice(0, 300) || "万相接口返回错误";
  return handledError(event, code, message, {
    stage,
    upstream_status: status,
    upstream_code: (json && json.code) || null,
    upstream_request_id: (json && json.request_id) || null,
  });
}

async function createTask(event, apiKey, base, model) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";

  if (raw.length > MAX_BODY_CHARS) {
    return handledError(event, "payload_too_large", "图片太大（超过约 1.5 MB），请重新压缩后再试", {
      stage: "validate",
    });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    return handledError(event, "invalid_json", "请求体不是合法 JSON", { stage: "validate" });
  }

  const image = normalizeImage(payload.image_base64);
  if (!image) {
    return handledError(
      event,
      "invalid_image",
      "图片格式不支持，或图片超过 1.5 MB",
      { stage: "validate" }
    );
  }

  let prompt = String(payload.prompt || "").trim();
  if (!prompt) {
    return handledError(event, "missing_prompt", "prompt 不能为空", { stage: "validate" });
  }
  if (prompt.length > 2000) prompt = prompt.slice(0, 2000);

  const negative = String(payload.negative_prompt || "").trim().slice(0, 500);
  if (negative) {
    const tail = `\n不要出现：${negative}`;
    if (prompt.length + tail.length > 2000) {
      prompt = prompt.slice(0, Math.max(0, 2000 - tail.length));
    }
    prompt += tail;
  }

  const size = computeSize(payload.width, payload.height);

  const body = {
    model,
    input: { prompt, images: [image] },
    parameters: {
      size,
      n: 1,
      prompt_extend: false,
      watermark: false,
    },
  };

  let response;
  try {
    response = await fetchWithTimeout(
      `${base}/services/aigc/image2image/image-synthesis`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable",
        },
        body: JSON.stringify(body),
      }
    );
  } catch (error) {
    const isTimeout =
      error && (error.name === "AbortError" || error.name === "TimeoutError");
    return handledError(
      event,
      isTimeout ? "submit_timeout" : "submit_unreachable",
      isTimeout ? "提交万相任务超时（5 秒）" : "无法连接万相接口",
      { stage: "submit", error_name: (error && error.name) || "Error" }
    );
  }

  const text = await response.text();
  const json = parseJson(text);

  if (!response.ok) {
    return upstreamError(event, "submit", response.status, json, text);
  }

  const taskId = json && json.output && json.output.task_id;
  if (!taskId) {
    return handledError(event, "no_task_id", "万相没有返回 task_id", {
      stage: "submit",
      upstream_status: response.status,
    });
  }

  // 拿到 task_id 立刻返回，绝不在函数里等图
  return ok(event, {
    task_id: taskId,
    request_id: (json && json.request_id) || null,
    size,
  });
}

async function queryTask(event, apiKey, base) {
  const params = event.queryStringParameters || {};
  const taskId = String(params.task_id || "").trim();

  if (!/^[A-Za-z0-9-]{8,64}$/.test(taskId)) {
    return handledError(event, "invalid_task_id", "task_id 不合法", { stage: "query" });
  }

  let response;
  try {
    response = await fetchWithTimeout(`${base}/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    const isTimeout =
      error && (error.name === "AbortError" || error.name === "TimeoutError");
    return handledError(
      event,
      isTimeout ? "query_timeout" : "query_unreachable",
      isTimeout ? "查询万相任务超时（5 秒）" : "无法连接万相接口",
      { stage: "query", error_name: (error && error.name) || "Error" }
    );
  }

  const text = await response.text();
  const json = parseJson(text);

  if (!response.ok) {
    return upstreamError(event, "query", response.status, json, text);
  }

  const output = (json && json.output) || {};
  const status = output.task_status || "UNKNOWN";

  let imageUrl = null;

  if (Array.isArray(output.results)) {
    for (const item of output.results) {
      if (item && typeof item.url === "string") {
        imageUrl = item.url;
        break;
      }
    }
  }

  if (!imageUrl && Array.isArray(output.choices)) {
    for (const choice of output.choices) {
      const content = choice && choice.message && choice.message.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const url = part && (part.image || part.image_url || part.url);
        if (typeof url === "string") {
          imageUrl = url;
          break;
        }
      }
      if (imageUrl) break;
    }
  }

  return ok(event, {
    status,
    image_url: imageUrl,
    message: output.message || (json && json.message) || "",
  });
}

exports.handler = async (event) => {
  try {
    const method = String(event.httpMethod || "").toUpperCase();
    const params = event.queryStringParameters || {};

    if (method === "OPTIONS") {
      return { statusCode: 204, headers: headersFor(event), body: "" };
    }

    const base = String(process.env.DASHSCOPE_BASE_URL || DEFAULT_BASE)
      .trim()
      .replace(/\/+$/, "");
    const model = String(process.env.DASHSCOPE_MODEL || DEFAULT_MODEL).trim();

    // 健康检查：浏览器直接打开 /api/proxy?health=1 就能确认函数是否活着
    if (method === "GET" && (params.health === "1" || params.health === "true")) {
      return ok(event, {
        configured: Boolean(String(process.env.DASHSCOPE_API_KEY || "").trim()),
        base,
        model,
        node: process.version,
      });
    }

    const apiKey = String(process.env.DASHSCOPE_API_KEY || "").trim();
    if (!apiKey) {
      return handledError(
        event,
        "server_misconfigured",
        "缺少 DASHSCOPE_API_KEY 环境变量",
        { stage: "config" }
      );
    }

    const expectedToken = String(process.env.APP_TOKEN || "").trim();
    if (expectedToken) {
      const got =
        (event.headers && (event.headers["x-app-token"] || event.headers["X-App-Token"])) || "";
      if (!safeEqual(got, expectedToken)) {
        return handledError(event, "unauthorized", "访问口令不正确", { stage: "auth" });
      }
    }

    if (method === "POST") return await createTask(event, apiKey, base, model);
    if (method === "GET") return await queryTask(event, apiKey, base);

    return handledError(event, "method_not_allowed", "只支持 POST 和 GET", {
      stage: "route",
    });
  } catch (error) {
    // 最后一道保险：任何未预期异常都转成可读 JSON，不抛给 Netlify 变成 502
    return handledError(
      event,
      "unhandled",
      (error && error.message) || "函数内部错误",
      {
        stage: "unhandled",
        error_name: (error && error.name) || "Error",
      }
    );
  }
};
