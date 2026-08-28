\set ON_ERROR_STOP on

\if :{?primary_database}
\else
\set primary_database amazon_asin_monitor
\endif

\if :{?competitor_database}
\else
\set competitor_database amazon_competitor_monitor
\endif

-- P1-T2 PostgreSQL baseline. Run with psql so the two independent databases
-- can be selected through \connect. P1-T4 owns hypertables and continuous aggregates.

\connect :primary_database

ALTER DATABASE :"primary_database" SET timezone TO 'Asia/Shanghai';
SET TIME ZONE 'Asia/Shanghai';

BEGIN;

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE OR REPLACE FUNCTION set_updated_timestamp_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  CASE TG_ARGV[0]
    WHEN 'update_time' THEN NEW.update_time := LOCALTIMESTAMP;
    WHEN 'updated_at' THEN NEW.updated_at := LOCALTIMESTAMP;
    ELSE
      RAISE EXCEPTION 'unsupported timestamp column: %', TG_ARGV[0]
        USING ERRCODE = '22023';
  END CASE;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS variant_groups (
  id varchar(50) PRIMARY KEY,
  name varchar(255) NOT NULL,
  country varchar(10) NOT NULL,
  site varchar(100) NOT NULL,
  brand varchar(100) NOT NULL,
  is_broken boolean DEFAULT false,
  variant_status varchar(20) DEFAULT 'NORMAL',
  manual_broken boolean DEFAULT false,
  manual_broken_reason varchar(500),
  manual_broken_updated_at timestamp without time zone,
  manual_broken_updated_by varchar(100),
  is_competitor boolean DEFAULT false,
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  update_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  last_check_time timestamp without time zone,
  feishu_notify_enabled boolean DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_variant_groups_country ON variant_groups (country);
CREATE INDEX IF NOT EXISTS idx_variant_groups_site ON variant_groups (site);
CREATE INDEX IF NOT EXISTS idx_variant_groups_brand ON variant_groups (brand);
CREATE INDEX IF NOT EXISTS idx_variant_groups_is_broken ON variant_groups (is_broken);
CREATE INDEX IF NOT EXISTS idx_variant_groups_manual_broken ON variant_groups (manual_broken);
CREATE INDEX IF NOT EXISTS idx_variant_groups_create_time ON variant_groups (create_time);
CREATE INDEX IF NOT EXISTS idx_variant_groups_last_check_time ON variant_groups (last_check_time);
CREATE INDEX IF NOT EXISTS idx_variant_groups_feishu_notify_enabled ON variant_groups (feishu_notify_enabled);
CREATE INDEX IF NOT EXISTS idx_variant_groups_country_broken ON variant_groups (country, is_broken);
CREATE INDEX IF NOT EXISTS idx_variant_groups_name ON variant_groups (name);

DROP TRIGGER IF EXISTS trg_variant_groups_update_time ON variant_groups;
CREATE TRIGGER trg_variant_groups_update_time
BEFORE UPDATE ON variant_groups
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('update_time');

CREATE TABLE IF NOT EXISTS asins (
  id varchar(50) PRIMARY KEY,
  asin varchar(20) NOT NULL,
  name varchar(500),
  asin_type varchar(20),
  country varchar(10) NOT NULL,
  site varchar(100) NOT NULL,
  brand varchar(100) NOT NULL,
  variant_group_id varchar(50) NOT NULL,
  is_broken boolean DEFAULT false,
  variant_status varchar(20) DEFAULT 'NORMAL',
  manual_broken boolean DEFAULT false,
  manual_broken_reason varchar(500),
  manual_broken_updated_at timestamp without time zone,
  manual_broken_updated_by varchar(100),
  manual_excluded_from_group boolean DEFAULT false,
  manual_excluded_reason varchar(500),
  manual_excluded_updated_at timestamp without time zone,
  manual_excluded_updated_by varchar(100),
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  update_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  last_check_time timestamp without time zone,
  feishu_notify_enabled boolean DEFAULT true,
  CONSTRAINT uk_asins_asin_country UNIQUE (asin, country),
  CONSTRAINT fk_asins_variant_group
    FOREIGN KEY (variant_group_id) REFERENCES variant_groups (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asins_variant_group_id ON asins (variant_group_id);
CREATE INDEX IF NOT EXISTS idx_asins_country ON asins (country);
CREATE INDEX IF NOT EXISTS idx_asins_site ON asins (site);
CREATE INDEX IF NOT EXISTS idx_asins_brand ON asins (brand);
CREATE INDEX IF NOT EXISTS idx_asins_asin ON asins (asin);
CREATE INDEX IF NOT EXISTS idx_asins_asin_type ON asins (asin_type);
CREATE INDEX IF NOT EXISTS idx_asins_is_broken ON asins (is_broken);
CREATE INDEX IF NOT EXISTS idx_asins_manual_broken ON asins (manual_broken);
CREATE INDEX IF NOT EXISTS idx_asins_manual_excluded_from_group ON asins (manual_excluded_from_group);
CREATE INDEX IF NOT EXISTS idx_asins_last_check_time ON asins (last_check_time);
CREATE INDEX IF NOT EXISTS idx_asins_feishu_notify_enabled ON asins (feishu_notify_enabled);
CREATE INDEX IF NOT EXISTS idx_asins_variant_group_country_broken ON asins (variant_group_id, country, is_broken);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asins_asin_country_ci ON asins (lower(asin), lower(country));

DROP TRIGGER IF EXISTS trg_asins_update_time ON asins;
CREATE TRIGGER trg_asins_update_time
BEFORE UPDATE ON asins
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('update_time');

CREATE TABLE IF NOT EXISTS monitor_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_group_id varchar(50),
  variant_group_name varchar(255),
  asin_id varchar(50),
  asin_code varchar(20),
  asin_name varchar(500),
  site_snapshot varchar(100),
  brand_snapshot varchar(255),
  check_type varchar(20) DEFAULT 'GROUP',
  country varchar(10) NOT NULL,
  is_broken boolean DEFAULT false,
  check_time timestamp without time zone NOT NULL,
  hour_ts timestamp without time zone
    GENERATED ALWAYS AS (date_trunc('hour', check_time)) STORED,
  day_ts timestamp without time zone
    GENERATED ALWAYS AS (date_trunc('day', check_time)) STORED,
  month_ts timestamp without time zone
    GENERATED ALWAYS AS (date_trunc('month', check_time)) STORED,
  check_result jsonb,
  notification_sent boolean DEFAULT false,
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_monitor_history_variant_group_id ON monitor_history (variant_group_id);
CREATE INDEX IF NOT EXISTS idx_monitor_history_asin_id ON monitor_history (asin_id);
CREATE INDEX IF NOT EXISTS idx_monitor_history_asin_code ON monitor_history (asin_code);
CREATE INDEX IF NOT EXISTS idx_monitor_history_check_time ON monitor_history (check_time);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country ON monitor_history (country);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_check_time ON monitor_history (country, check_time);
CREATE INDEX IF NOT EXISTS idx_monitor_history_variant_group_check_time_broken ON monitor_history (variant_group_id, check_time, is_broken);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_check_time_broken ON monitor_history (country, check_time, is_broken);
CREATE INDEX IF NOT EXISTS idx_monitor_history_check_time_country_broken ON monitor_history (check_time, country, is_broken);
CREATE INDEX IF NOT EXISTS idx_monitor_history_asin_code_country_check_time ON monitor_history (asin_code, country, check_time);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_time_broken_asin ON monitor_history (country, check_time, is_broken, asin_id);
CREATE INDEX IF NOT EXISTS idx_monitor_history_asin_country_check_time_broken ON monitor_history (asin_id, country, check_time, is_broken);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_hour_site_brand ON monitor_history (country, hour_ts, site_snapshot, brand_snapshot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_day_site_brand ON monitor_history (country, day_ts, site_snapshot, brand_snapshot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_month_site_brand ON monitor_history (country, month_ts, site_snapshot, brand_snapshot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_hour_country_asin ON monitor_history (hour_ts, country, asin_id, asin_code, is_broken);
CREATE INDEX IF NOT EXISTS idx_monitor_history_day_country_asin ON monitor_history (day_ts, country, asin_id, asin_code, is_broken);
CREATE INDEX IF NOT EXISTS idx_monitor_history_month_country_asin ON monitor_history (month_ts, country, asin_id, asin_code, is_broken);
CREATE INDEX IF NOT EXISTS idx_monitor_history_status_interval_refresh ON monitor_history (check_type, check_time, id);

CREATE TABLE IF NOT EXISTS monitor_history_agg (
  granularity varchar(5) NOT NULL,
  time_slot timestamp without time zone NOT NULL,
  country varchar(10) NOT NULL,
  asin_key varchar(50) NOT NULL,
  check_count integer NOT NULL,
  broken_count integer NOT NULL,
  has_broken boolean NOT NULL,
  has_peak boolean NOT NULL,
  first_check_time timestamp without time zone NOT NULL,
  last_check_time timestamp without time zone NOT NULL,
  updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT ck_monitor_history_agg_granularity
    CHECK (granularity IN ('hour', 'day', 'month')),
  CONSTRAINT pk_monitor_history_agg
    PRIMARY KEY (granularity, time_slot, country, asin_key)
);

CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_time_slot ON monitor_history_agg (time_slot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_country_time_slot ON monitor_history_agg (country, time_slot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_granularity_time_slot ON monitor_history_agg (granularity, time_slot);

DROP TRIGGER IF EXISTS trg_monitor_history_agg_updated_at ON monitor_history_agg;
CREATE TRIGGER trg_monitor_history_agg_updated_at
BEFORE UPDATE ON monitor_history_agg
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('updated_at');

CREATE TABLE IF NOT EXISTS monitor_history_agg_dim (
  granularity varchar(5) NOT NULL,
  time_slot timestamp without time zone NOT NULL,
  country varchar(10) NOT NULL,
  site varchar(100) NOT NULL DEFAULT '',
  brand varchar(255) NOT NULL DEFAULT '',
  asin_key varchar(50) NOT NULL,
  check_count integer NOT NULL,
  broken_count integer NOT NULL,
  has_broken boolean NOT NULL,
  has_peak boolean NOT NULL,
  first_check_time timestamp without time zone NOT NULL,
  last_check_time timestamp without time zone NOT NULL,
  updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT ck_monitor_history_agg_dim_granularity
    CHECK (granularity IN ('hour', 'day', 'month')),
  CONSTRAINT pk_monitor_history_agg_dim
    PRIMARY KEY (granularity, time_slot, country, site, brand, asin_key)
);

CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_dim_time_slot ON monitor_history_agg_dim (time_slot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_dim_country_time_slot ON monitor_history_agg_dim (country, time_slot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_dim_granularity_time_slot ON monitor_history_agg_dim (granularity, time_slot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_dim_country_site_brand_slot ON monitor_history_agg_dim (country, site, brand, time_slot);

DROP TRIGGER IF EXISTS trg_monitor_history_agg_dim_updated_at ON monitor_history_agg_dim;
CREATE TRIGGER trg_monitor_history_agg_dim_updated_at
BEFORE UPDATE ON monitor_history_agg_dim
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('updated_at');

CREATE TABLE IF NOT EXISTS monitor_history_agg_variant_group (
  granularity varchar(5) NOT NULL,
  time_slot timestamp without time zone NOT NULL,
  country varchar(10) NOT NULL,
  variant_group_id varchar(50) NOT NULL,
  variant_group_name varchar(255) NOT NULL DEFAULT '',
  asin_key varchar(50) NOT NULL,
  check_count integer NOT NULL,
  broken_count integer NOT NULL,
  has_broken boolean NOT NULL,
  has_peak boolean NOT NULL,
  first_check_time timestamp without time zone NOT NULL,
  last_check_time timestamp without time zone NOT NULL,
  updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT ck_monitor_history_agg_variant_group_granularity
    CHECK (granularity IN ('hour', 'day', 'month')),
  CONSTRAINT pk_monitor_history_agg_variant_group
    PRIMARY KEY (granularity, time_slot, country, variant_group_id, asin_key)
);

CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_variant_group_slot ON monitor_history_agg_variant_group (time_slot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_variant_group_country_slot ON monitor_history_agg_variant_group (country, time_slot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_variant_group_lookup ON monitor_history_agg_variant_group (granularity, country, variant_group_id, time_slot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_variant_group_time_slot ON monitor_history_agg_variant_group (time_slot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_variant_group_country_time_slot ON monitor_history_agg_variant_group (country, time_slot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_variant_group_group_slot ON monitor_history_agg_variant_group (variant_group_id, time_slot);
CREATE INDEX IF NOT EXISTS idx_monitor_history_agg_variant_group_granularity_time_slot ON monitor_history_agg_variant_group (granularity, time_slot);

DROP TRIGGER IF EXISTS trg_monitor_history_agg_variant_group_updated_at ON monitor_history_agg_variant_group;
CREATE TRIGGER trg_monitor_history_agg_variant_group_updated_at
BEFORE UPDATE ON monitor_history_agg_variant_group
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('updated_at');

CREATE TABLE IF NOT EXISTS analytics_refresh_watermark (
  processor_name varchar(100) PRIMARY KEY,
  last_history_id bigint NOT NULL DEFAULT 0,
  last_check_time timestamp without time zone,
  updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP
);

DROP TRIGGER IF EXISTS trg_analytics_refresh_watermark_updated_at ON analytics_refresh_watermark;
CREATE TRIGGER trg_analytics_refresh_watermark_updated_at
BEFORE UPDATE ON analytics_refresh_watermark
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('updated_at');

CREATE TABLE IF NOT EXISTS monitor_history_status_interval (
  asin_key varchar(50) NOT NULL,
  asin_id varchar(50),
  asin_code varchar(20),
  asin_name varchar(500),
  country varchar(10) NOT NULL,
  variant_group_id varchar(50),
  variant_group_name varchar(255),
  interval_start timestamp without time zone NOT NULL,
  interval_end timestamp without time zone,
  is_broken boolean NOT NULL,
  updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT pk_monitor_history_status_interval
    PRIMARY KEY (asin_key, country, interval_start)
);

CREATE INDEX IF NOT EXISTS idx_monitor_history_status_interval_country_start ON monitor_history_status_interval (country, interval_start);
CREATE INDEX IF NOT EXISTS idx_monitor_history_status_interval_variant_group_start ON monitor_history_status_interval (variant_group_id, country, interval_start);
CREATE INDEX IF NOT EXISTS idx_monitor_history_status_interval_range ON monitor_history_status_interval (interval_start, interval_end);
CREATE INDEX IF NOT EXISTS idx_monitor_history_status_interval_broken_range ON monitor_history_status_interval (is_broken, interval_start, interval_end);
CREATE INDEX IF NOT EXISTS idx_monitor_history_status_interval_open_lookup ON monitor_history_status_interval (asin_key, country, interval_end);

DROP TRIGGER IF EXISTS trg_monitor_history_status_interval_updated_at ON monitor_history_status_interval;
CREATE TRIGGER trg_monitor_history_status_interval_updated_at
BEFORE UPDATE ON monitor_history_status_interval
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('updated_at');

CREATE TABLE IF NOT EXISTS feishu_config (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  country varchar(10) NOT NULL,
  webhook_url varchar(500) NOT NULL,
  enabled boolean DEFAULT true,
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  update_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT feishu_config_country_unique UNIQUE (country)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_feishu_config_country_ci ON feishu_config (lower(country));

DROP TRIGGER IF EXISTS trg_feishu_config_update_time ON feishu_config;
CREATE TRIGGER trg_feishu_config_update_time
BEFORE UPDATE ON feishu_config
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('update_time');

CREATE TABLE IF NOT EXISTS sp_api_config (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  config_key varchar(50) NOT NULL,
  config_value text,
  description varchar(255),
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  update_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT sp_api_config_config_key_unique UNIQUE (config_key)
);

CREATE INDEX IF NOT EXISTS idx_sp_api_config_key ON sp_api_config (config_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sp_api_config_key_ci ON sp_api_config (lower(config_key));

DROP TRIGGER IF EXISTS trg_sp_api_config_update_time ON sp_api_config;
CREATE TRIGGER trg_sp_api_config_update_time
BEFORE UPDATE ON sp_api_config
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('update_time');

CREATE TABLE IF NOT EXISTS backup_config (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enabled boolean DEFAULT false,
  schedule_type varchar(20) DEFAULT 'daily',
  schedule_value integer,
  backup_time varchar(10) DEFAULT '02:00',
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  update_time timestamp without time zone DEFAULT LOCALTIMESTAMP
);

DROP TRIGGER IF EXISTS trg_backup_config_update_time ON backup_config;
CREATE TRIGGER trg_backup_config_update_time
BEFORE UPDATE ON backup_config
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('update_time');

CREATE TABLE IF NOT EXISTS users (
  id varchar(50) PRIMARY KEY,
  username varchar(50) NOT NULL,
  password varchar(255) NOT NULL,
  real_name varchar(100),
  status varchar(10) NOT NULL DEFAULT 'ACTIVE',
  last_login_time timestamp without time zone,
  last_login_ip varchar(50),
  password_expires_at timestamp without time zone,
  password_changed_at timestamp without time zone,
  force_password_change boolean DEFAULT false,
  failed_login_attempts integer DEFAULT 0,
  locked_until timestamp without time zone,
  last_failed_login timestamp without time zone,
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  update_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT users_username_unique UNIQUE (username),
  CONSTRAINT ck_users_status
    CHECK (status IN ('ACTIVE', 'INACTIVE', 'LOCKED', 'SUSPENDED', 'PENDING'))
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username_ci ON users (lower(username));

DROP TRIGGER IF EXISTS trg_users_update_time ON users;
CREATE TRIGGER trg_users_update_time
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('update_time');

CREATE TABLE IF NOT EXISTS password_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id varchar(50) NOT NULL,
  password_hash varchar(255) NOT NULL,
  created_at timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT fk_password_history_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_history_user_id ON password_history (user_id);
CREATE INDEX IF NOT EXISTS idx_password_history_user_created ON password_history (user_id, created_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username varchar(50) NOT NULL,
  ip_address varchar(64),
  success boolean NOT NULL,
  created_at timestamp without time zone DEFAULT LOCALTIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_username_time ON login_attempts (username, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts (ip_address, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_created_at ON login_attempts (created_at);

CREATE TABLE IF NOT EXISTS user_status_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id varchar(50) NOT NULL,
  old_status varchar(20),
  new_status varchar(20) NOT NULL,
  reason varchar(255),
  changed_by varchar(50),
  created_at timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT fk_user_status_history_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_status_history_user_id ON user_status_history (user_id);
CREATE INDEX IF NOT EXISTS idx_user_status_history_created_at ON user_status_history (created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id char(36) PRIMARY KEY,
  user_id varchar(50) NOT NULL,
  user_agent varchar(255),
  ip_address varchar(64),
  status varchar(7) NOT NULL DEFAULT 'ACTIVE',
  remember_me boolean NOT NULL DEFAULT false,
  created_at timestamp without time zone NOT NULL DEFAULT LOCALTIMESTAMP,
  last_active_at timestamp without time zone NOT NULL DEFAULT LOCALTIMESTAMP,
  expires_at timestamp without time zone,
  CONSTRAINT ck_sessions_status CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT fk_sessions_user_id
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);

CREATE TABLE IF NOT EXISTS roles (
  id varchar(50) PRIMARY KEY,
  code varchar(50) NOT NULL,
  name varchar(100) NOT NULL,
  description varchar(255),
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  update_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT roles_code_unique UNIQUE (code)
);

CREATE INDEX IF NOT EXISTS idx_roles_code ON roles (code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_code_ci ON roles (lower(code));

DROP TRIGGER IF EXISTS trg_roles_update_time ON roles;
CREATE TRIGGER trg_roles_update_time
BEFORE UPDATE ON roles
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('update_time');

CREATE TABLE IF NOT EXISTS permissions (
  id varchar(50) PRIMARY KEY,
  code varchar(50) NOT NULL,
  name varchar(100) NOT NULL,
  resource varchar(100),
  action varchar(50),
  description varchar(255),
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT permissions_code_unique UNIQUE (code)
);

CREATE INDEX IF NOT EXISTS idx_permissions_code ON permissions (code);
CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions (resource);
CREATE UNIQUE INDEX IF NOT EXISTS uq_permissions_code_ci ON permissions (lower(code));

CREATE TABLE IF NOT EXISTS user_roles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id varchar(50) NOT NULL,
  role_id varchar(50) NOT NULL,
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT uk_user_roles_user_role UNIQUE (user_id, role_id),
  CONSTRAINT fk_user_roles_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_roles_role
    FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles (user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles (role_id);

CREATE TABLE IF NOT EXISTS role_permissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_id varchar(50) NOT NULL,
  permission_id varchar(50) NOT NULL,
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT uk_role_permissions_role_permission UNIQUE (role_id, permission_id),
  CONSTRAINT fk_role_permissions_role
    FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_permission
    FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role_id ON role_permissions (role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_id ON role_permissions (permission_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id varchar(50),
  username varchar(50),
  action varchar(50) NOT NULL,
  resource varchar(100),
  resource_id varchar(50),
  resource_name varchar(255),
  method varchar(10),
  path varchar(500),
  ip_address varchar(50),
  user_agent varchar(500),
  request_data jsonb,
  response_status integer,
  error_message text,
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_username ON audit_logs (username);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs (resource);
CREATE INDEX IF NOT EXISTS idx_audit_logs_create_time ON audit_logs (create_time);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_id ON audit_logs (resource_id);

INSERT INTO backup_config (id, enabled, schedule_type, backup_time)
OVERRIDING SYSTEM VALUE
VALUES (1, false, 'daily', '02:00')
ON CONFLICT (id) DO NOTHING;

SELECT setval(
  pg_get_serial_sequence('backup_config', 'id'),
  GREATEST((SELECT COALESCE(MAX(id), 1) FROM backup_config), 1),
  true
);

INSERT INTO roles (id, code, name, description) VALUES
  ('role-001', 'READONLY', '只读用户', '只能查看数据，不能修改'),
  ('role-002', 'EDITOR', '编辑用户', '可以查看和修改业务数据与系统设置，但不能管理用户、角色和审计'),
  ('role-003', 'ADMIN', '管理员', '拥有所有权限，包括用户、角色、审计和系统设置')
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code,
  name = EXCLUDED.name,
  description = EXCLUDED.description;

INSERT INTO permissions (id, code, name, resource, action, description) VALUES
  ('perm-001', 'asin:read', '查看ASIN', 'asin', 'read', '查看ASIN列表和详情'),
  ('perm-002', 'asin:write', '编辑ASIN', 'asin', 'write', '创建、修改、删除ASIN'),
  ('perm-003', 'monitor:read', '查看监控历史', 'monitor', 'read', '查看监控历史记录'),
  ('perm-004', 'analytics:read', '查看数据分析', 'analytics', 'read', '查看数据分析报表'),
  ('perm-005', 'settings:read', '查看系统设置', 'settings', 'read', '查看系统配置'),
  ('perm-006', 'settings:write', '修改系统设置', 'settings', 'write', '修改系统配置'),
  ('perm-007', 'user:read', '查看用户', 'user', 'read', '查看用户列表'),
  ('perm-008', 'user:write', '管理用户', 'user', 'write', '创建、修改用户信息'),
  ('perm-009', 'asin:delete', '删除ASIN', 'asin', 'delete', '删除ASIN记录'),
  ('perm-010', 'monitor:write', '管理监控任务', 'monitor', 'write', '创建和管理监控任务'),
  ('perm-011', 'user:delete', '删除用户', 'user', 'delete', '删除用户账户'),
  ('perm-012', 'role:read', '查看角色', 'role', 'read', '查看角色列表和详情'),
  ('perm-013', 'role:write', '管理角色', 'role', 'write', '创建、修改、删除角色和权限分配'),
  ('perm-014', 'audit:read', '查看审计日志', 'audit', 'read', '查看操作审计日志')
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code,
  name = EXCLUDED.name,
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('role-001', 'perm-001'),
  ('role-001', 'perm-003'),
  ('role-001', 'perm-004'),
  ('role-002', 'perm-001'),
  ('role-002', 'perm-002'),
  ('role-002', 'perm-009'),
  ('role-002', 'perm-003'),
  ('role-002', 'perm-010'),
  ('role-002', 'perm-004'),
  ('role-002', 'perm-005'),
  ('role-002', 'perm-006'),
  ('role-003', 'perm-001'),
  ('role-003', 'perm-002'),
  ('role-003', 'perm-003'),
  ('role-003', 'perm-004'),
  ('role-003', 'perm-005'),
  ('role-003', 'perm-006'),
  ('role-003', 'perm-007'),
  ('role-003', 'perm-008'),
  ('role-003', 'perm-009'),
  ('role-003', 'perm-010'),
  ('role-003', 'perm-011'),
  ('role-003', 'perm-012'),
  ('role-003', 'perm-013'),
  ('role-003', 'perm-014')
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;

\connect :competitor_database

ALTER DATABASE :"competitor_database" SET timezone TO 'Asia/Shanghai';
SET TIME ZONE 'Asia/Shanghai';

BEGIN;

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE OR REPLACE FUNCTION set_updated_timestamp_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  CASE TG_ARGV[0]
    WHEN 'update_time' THEN NEW.update_time := LOCALTIMESTAMP;
    WHEN 'updated_at' THEN NEW.updated_at := LOCALTIMESTAMP;
    ELSE
      RAISE EXCEPTION 'unsupported timestamp column: %', TG_ARGV[0]
        USING ERRCODE = '22023';
  END CASE;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS competitor_variant_groups (
  id varchar(50) PRIMARY KEY,
  name varchar(255) NOT NULL,
  country varchar(10) NOT NULL,
  brand varchar(100) NOT NULL,
  is_broken boolean DEFAULT false,
  variant_status varchar(20) DEFAULT 'NORMAL',
  feishu_notify_enabled boolean DEFAULT false,
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  update_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  last_check_time timestamp without time zone
);

CREATE INDEX IF NOT EXISTS idx_competitor_variant_groups_country ON competitor_variant_groups (country);
CREATE INDEX IF NOT EXISTS idx_competitor_variant_groups_brand ON competitor_variant_groups (brand);
CREATE INDEX IF NOT EXISTS idx_competitor_variant_groups_is_broken ON competitor_variant_groups (is_broken);
CREATE INDEX IF NOT EXISTS idx_competitor_variant_groups_create_time ON competitor_variant_groups (create_time);
CREATE INDEX IF NOT EXISTS idx_competitor_variant_groups_last_check_time ON competitor_variant_groups (last_check_time);
CREATE INDEX IF NOT EXISTS idx_competitor_variant_groups_feishu_notify_enabled ON competitor_variant_groups (feishu_notify_enabled);

DROP TRIGGER IF EXISTS trg_competitor_variant_groups_update_time ON competitor_variant_groups;
CREATE TRIGGER trg_competitor_variant_groups_update_time
BEFORE UPDATE ON competitor_variant_groups
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('update_time');

CREATE TABLE IF NOT EXISTS competitor_asins (
  id varchar(50) PRIMARY KEY,
  asin varchar(20) NOT NULL,
  name varchar(500),
  asin_type varchar(20),
  country varchar(10) NOT NULL,
  brand varchar(100) NOT NULL,
  variant_group_id varchar(50) NOT NULL,
  is_broken boolean DEFAULT false,
  variant_status varchar(20) DEFAULT 'NORMAL',
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  update_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  last_check_time timestamp without time zone,
  feishu_notify_enabled boolean DEFAULT false,
  CONSTRAINT uk_competitor_asins_asin_country UNIQUE (asin, country),
  CONSTRAINT fk_competitor_asins_variant_group
    FOREIGN KEY (variant_group_id) REFERENCES competitor_variant_groups (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_competitor_asins_variant_group_id ON competitor_asins (variant_group_id);
CREATE INDEX IF NOT EXISTS idx_competitor_asins_country ON competitor_asins (country);
CREATE INDEX IF NOT EXISTS idx_competitor_asins_brand ON competitor_asins (brand);
CREATE INDEX IF NOT EXISTS idx_competitor_asins_asin ON competitor_asins (asin);
CREATE INDEX IF NOT EXISTS idx_competitor_asins_asin_type ON competitor_asins (asin_type);
CREATE INDEX IF NOT EXISTS idx_competitor_asins_is_broken ON competitor_asins (is_broken);
CREATE INDEX IF NOT EXISTS idx_competitor_asins_last_check_time ON competitor_asins (last_check_time);
CREATE INDEX IF NOT EXISTS idx_competitor_asins_feishu_notify_enabled ON competitor_asins (feishu_notify_enabled);
CREATE UNIQUE INDEX IF NOT EXISTS uq_competitor_asins_asin_country_ci ON competitor_asins (lower(asin), lower(country));

DROP TRIGGER IF EXISTS trg_competitor_asins_update_time ON competitor_asins;
CREATE TRIGGER trg_competitor_asins_update_time
BEFORE UPDATE ON competitor_asins
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('update_time');

CREATE TABLE IF NOT EXISTS competitor_monitor_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_group_id varchar(50),
  variant_group_name varchar(255),
  asin_id varchar(50),
  asin_code varchar(20),
  asin_name varchar(500),
  check_type varchar(20) DEFAULT 'GROUP',
  country varchar(10) NOT NULL,
  is_broken boolean DEFAULT false,
  check_time timestamp without time zone NOT NULL,
  check_result jsonb,
  notification_sent boolean DEFAULT false,
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_competitor_monitor_history_variant_group_id ON competitor_monitor_history (variant_group_id);
CREATE INDEX IF NOT EXISTS idx_competitor_monitor_history_asin_id ON competitor_monitor_history (asin_id);
CREATE INDEX IF NOT EXISTS idx_competitor_monitor_history_check_time ON competitor_monitor_history (check_time);
CREATE INDEX IF NOT EXISTS idx_competitor_monitor_history_country ON competitor_monitor_history (country);

CREATE TABLE IF NOT EXISTS competitor_feishu_config (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  country varchar(10) NOT NULL,
  webhook_url varchar(500) NOT NULL,
  enabled boolean DEFAULT true,
  create_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  update_time timestamp without time zone DEFAULT LOCALTIMESTAMP,
  CONSTRAINT competitor_feishu_config_country_unique UNIQUE (country)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_competitor_feishu_config_country_ci ON competitor_feishu_config (lower(country));

DROP TRIGGER IF EXISTS trg_competitor_feishu_config_update_time ON competitor_feishu_config;
CREATE TRIGGER trg_competitor_feishu_config_update_time
BEFORE UPDATE ON competitor_feishu_config
FOR EACH ROW EXECUTE FUNCTION set_updated_timestamp_column('update_time');

COMMIT;
