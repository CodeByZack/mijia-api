/**
 * mijia-node —— 米家云端 API 的纯 Node.js 客户端。
 *
 * 直接调用 api.mijia.tech，无需 Python 或 Home Assistant 桥接。
 * 详见 README.md。
 */
export { MijiaAPI } from "./mijia.js";
export { MijiaApiClient } from "./api.js";
export type { ApiClientOptions, CallApiOptions } from "./api.js";
export { DEFAULT_SLEEP_TIME, MijiaDevice, resolveDevice, validateValue } from "./device.js";
export type { DeviceApiClient, DeviceLookupOptions } from "./device.js";
export {
  API_BASE_URL,
  AuthStore,
  LOGIN_URL,
  completeLogin,
  getLocation,
  isAuthExpired,
  loginQR,
  printQR,
  refreshToken,
  requestLoginData,
} from "./login.js";
export type { AuthStoreOptions, LocationResult } from "./login.js";
export { DEVICE_INFO_VERSION, SPEC_BASE_URL, buildSpec, fetchSpec, getDeviceInfo, parseSpecHtml } from "./spec.js";
export type { SpecOptions } from "./spec.js";
export {
  RC4,
  RC4_WARMUP_BYTES,
  decrypt,
  decryptJSON,
  decryptRC4,
  encryptRC4,
  genEncSignature,
  genNonce,
  generateEncParams,
  getSignedNonce,
  isValidUtf8,
  toMinimalBigEndian,
} from "./crypto.js";
export { ERROR_CODE, errorMessage } from "./errors.js";
export {
  APIError,
  DeviceActionError,
  DeviceGetError,
  DeviceNotFoundError,
  DeviceSetError,
  GetDeviceInfoError,
  LoginError,
  MijiaError,
  MultipleDevicesFoundError,
} from "./errors.js";
export {
  DEVICE_ID_CHARS,
  HEX_LOWER,
  HEX_UPPER,
  buildUserAgent,
  countryOf,
  daylightInfo,
  detectLocale,
  fetchWithTimeout,
  localTimezoneName,
  mapWithConcurrency,
  parseCookieHeader,
  parseQueryString,
  parseServiceRet,
  randomChars,
  randomDeviceId,
  randomHex,
  sleep,
  stripServiceMarker,
  toFormUrlEncoded,
  utcOffsetString,
} from "./util.js";
export type {
  ActionItem,
  ActionResult,
  ActionMap,
  AuthData,
  CloudResponse,
  Consumable,
  ConsumableDetail,
  DeviceAction,
  DeviceInfo,
  DeviceOptions,
  DeviceProperty,
  DeviceSpec,
  Home,
  Logger,
  LoginOptions,
  MethodParam,
  MijiaAPIOptions,
  PropGetItem,
  PropResult,
  PropSetItem,
  PropertyMap,
  PropertyType,
  QRLoginData,
  Room,
  Scene,
  SiidPiidMap,
  ValueItem,
} from "./types.js";