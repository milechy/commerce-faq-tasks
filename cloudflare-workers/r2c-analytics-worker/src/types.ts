export interface Env {
  ENVIRONMENT: string;
  INTERNAL_API_URL: string;
  INTERNAL_API_HMAC_SECRET: string;
  EMAIL: SendEmail;
  ALERT_EMAIL_TO: string;
}

export interface Ga4TenantHealthResult {
  tenant_id: string;
  status: string;
  error_message: string | null;
}
