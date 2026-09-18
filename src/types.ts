export interface Principal {
  clientId: string;
  role: "agent" | "device";
  deviceId?: string;
  credentialHash: string;
  scopes: string[];
  expiresAt?: number;
}
export interface Device {
  id: string;
  name: string;
  credentialId: string;
}
export interface Store {
  healthy(): Promise<boolean>;
  authenticate(token: string): Promise<Principal | undefined>;
  device(id: string): Promise<Device | undefined>;
  allowed(p: Principal, deviceId: string): Promise<boolean>;
  close(): Promise<void>;
}
export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const bytes = (x: unknown) =>
  Buffer.byteLength(JSON.stringify(x), "utf8");
export const alive = (p: Principal) => !p.expiresAt || p.expiresAt > Date.now();
