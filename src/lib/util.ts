import path from "path";
import crypto from "crypto";

import mime from "mime";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { format as dateFormat } from "date-fns";

// CRC32 查找表（模块级常量，避免每次调用重建）
const CRC32_TABLE = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc;
  }
  return table;
})();

const util = {
  uuid: (separator = true) => (separator ? uuidv4() : uuidv4().replace(/-/g, "")),

  getDateString(format = "yyyy-MM-dd", date = new Date()) {
    return dateFormat(date, format);
  },

  mimeToExtension(value: string) {
    let extension = mime.getExtension(value);
    if (extension == "mpga") return "mp3";
    return extension;
  },

  isBASE64(value: unknown) {
    return value != null && typeof value === "string" && /^[a-zA-Z0-9\/\+]+(=?)+$/.test(value);
  },

  isBASE64Data(value: unknown) {
    return typeof value === "string" && /^data:/.test(value);
  },

  extractBASE64DataFormat(value: string): string | null {
    const match = value.trim().match(/^data:(.+);base64,/);
    if (!match) return null;
    return match[1];
  },

  removeBASE64DataHeader(value: string): string {
    return value.replace(/^data:(.+);base64,/, "");
  },

  unixTimestamp() {
    return parseInt(`${Date.now() / 1000}`);
  },

  timestamp() {
    return Date.now();
  },

  md5(value: string | Buffer) {
    return crypto.createHash("md5").update(value).digest("hex");
  },

  async fetchFileBASE64(url: string) {
    const result = await axios.get(url, {
      responseType: "arraybuffer",
    });
    return result.data.toString("base64");
  },

  /**
   * 计算 ArrayBuffer 的 CRC32 值
   * @param buffer ArrayBuffer 数据
   * @returns CRC32 十六进制字符串
   */
  calculateCRC32(buffer: ArrayBuffer | Buffer): string {
    let crc = 0 ^ (-1);
    const bytes = buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xFF];
    }
    return ((crc ^ (-1)) >>> 0).toString(16).padStart(8, '0');
  },
};

/**
 * Mask a token for display, e.g. "abcd...wxyz"
 */
export function maskToken(token: string): string {
  if (token.length <= 10) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export default util;
