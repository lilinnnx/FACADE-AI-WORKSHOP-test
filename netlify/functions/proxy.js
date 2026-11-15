"use strict";

const crypto = require("crypto");

const DEFAULT_BASE = "https://dashscope.aliyuncs.com/api/v1";
const DEFAULT_MODEL = "wan2.5-i2i-preview";
const MAX_BODY_CHARS = 4600000;
const MAX_IMAGE_BYTES = 9.5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

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
    const host = event.headers.host || event.headers.Host || "";
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

function ok(event, payload, statusCode = 200) {
  return {
    statusCode,
    headers: headersFor(event),
    body: JSON.stringify(payload),
  };
}

function fail(event, statusCode, code, message) {
  return {
    statusCode,
    headers: headersFor(event),
    body: JSON.stringify({ error: { code, message } }),
  };
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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function upstreamFail(event, status, json, text) {
  const code = (json && json.code) || "dashscope_error";
  const message =
    (json && json.message) || String(text || "").slice(0, 300) || "万相接口返回错误";
  return fail(event, 502, code, message);
}

async function createTask(event, apiKey, base, model) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";

  if (raw.length > MAX_BODY_CHARS) {
    return fail(event, 413, "payload_too_large", "图片太大，请压缩后再试");
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    return fail(event, 400, "invalid_json", "请求体不是合法 JSON");
  }

  const image = normalizeImage(payload.image_base64);
  if (!image) {
    return fail(event, 400, "invalid_image", "图片格式不支持，或图片超过 10 MB");
  }

  let prompt = String(payload.prompt || "").trim();
  if (!prompt) {
    return fail(event, 400, "missing_prompt", "prompt 不能为空");
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
    input: {
      prompt,
      images: [image],
    },
    parameters: {
      size,
      n: 1,
      prompt_extend: false,
      watermark: false,
    },
  };

  const response = await fetchWithTimeout(
    `${base}/services/aigc/image2image/image-synthesis`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify(body),
    },
    REQUEST_TIMEOUT_MS
  );

  const text = await response.text();
  const json = parseJson(text);

  if (!response.ok) return upstreamFail(event, response.status, json, text);

  const taskId = json && json.output && json.output.task_id;
  if (!taskId) {
    return fail(event, 502, "no_task_id", "万相没有返回 task_id");
  }

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
    return fail(event, 400, "invalid_task_id", "task_id 不合法");
  }

  const response = await fetchWithTimeout(
    `${base}/tasks/${encodeURIComponent(taskId)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
    REQUEST_TIMEOUT_MS
  );

  const text = await response.text();
  const json = parseJson(text);

  if (!response.ok) return upstreamFail(event, response.status, json, text);

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

  const message = output.message || (json && json.message) || "";

  return ok(event, {
    status,
    image_url: imageUrl,
    message,
  });
}

exports.handler = async (event) => {
  const method = String(event.httpMethod || "").toUpperCase();

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: headersFor(event),
      body: "",
    };
  }

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return fail(event, 500, "server_misconfigured", "缺少 DASHSCOPE_API_KEY 环境变量");
  }

  if (process.env.APP_TOKEN) {
    const got =
      (event.headers && (event.headers["x-app-token"] || event.headers["X-App-Token"])) || "";
    if (!safeEqual(got, process.env.APP_TOKEN)) {
      return fail(event, 401, "unauthorized", "访问口令不正确");
    }
  }

  const base = String(process.env.DASHSCOPE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const model = process.env.DASHSCOPE_MODEL || DEFAULT_MODEL;

  try {
    if (method === "POST") return await createTask(event, apiKey, base, model);
    if (method === "GET") return await queryTask(event, apiKey, base);
    return fail(event, 405, "method_not_allowed", "只支持 POST 和 GET");
  } catch (error) {
    const isAbort = error && error.name === "AbortError";
    return fail(
      event,
      502,
      isAbort ? "upstream_timeout" : "upstream_error",
      isAbort ? "调用万相超时，请重试" : "调用万相失败"
    );
  }
};
