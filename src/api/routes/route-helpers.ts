import _ from "lodash";

export function isMultipartRequest(contentType: unknown): boolean {
  return _.isString(contentType) && contentType.startsWith("multipart/form-data");
}

export function assertNoUnsupportedParams(
  body: Record<string, unknown>,
  unsupportedParams: string[],
  messageBuilder?: (params: string[]) => string
): void {
  const bodyKeys = Object.keys(body || {});
  const foundUnsupported = unsupportedParams.filter((param) => bodyKeys.includes(param));
  if (foundUnsupported.length === 0) return;
  if (messageBuilder) throw new Error(messageBuilder(foundUnsupported));
  throw new Error(`Unsupported params: ${foundUnsupported.join(", ")}`);
}

export function parseOptionalNumber(value: unknown): number | undefined {
  if (_.isFinite(value)) return Number(value);
  if (_.isString(value) && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (_.isBoolean(value)) return value;
  if (_.isString(value)) {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

export function parseMultipartStrictInt(value: unknown): number | undefined {
  if (!_.isString(value)) return undefined;
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || value.trim() !== String(parsed)) return undefined;
  return parsed;
}

