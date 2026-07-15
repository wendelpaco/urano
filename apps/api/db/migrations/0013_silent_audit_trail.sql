CREATE TABLE "security_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" varchar(64) NOT NULL,
	"api_key_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_security_audit_log_action" ON "security_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_security_audit_log_api_key_id" ON "security_audit_log" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "idx_security_audit_log_created_at" ON "security_audit_log" USING btree ("created_at" DESC NULLS LAST);
