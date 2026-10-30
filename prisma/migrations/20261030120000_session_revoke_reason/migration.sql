-- G2b B: why a session was revoked; NULL = rotation/legacy (refresh treats a replay as token theft)
ALTER TABLE "Session" ADD COLUMN "revokeReason" TEXT;
