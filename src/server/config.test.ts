import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import {
	DEFAULT_BIND_HOST,
	DEFAULT_BIND_PORT,
	DEFAULT_DATA_DIR,
	loadServerConfigFromEnv,
} from "./config.ts";

describe("loadServerConfigFromEnv", () => {
	test("defaults to TCP on 0.0.0.0:8080 with /data + warren.db", () => {
		const config = loadServerConfigFromEnv({ env: { WARREN_API_TOKEN: "x" } });
		expect(config.transport.kind).toBe("tcp");
		if (config.transport.kind === "tcp") {
			expect(config.transport.hostname).toBe(DEFAULT_BIND_HOST);
			expect(config.transport.port).toBe(DEFAULT_BIND_PORT);
		}
		expect(config.dataDir).toBe(DEFAULT_DATA_DIR);
		expect(config.dbPath).toBe("/data/warren.db");
		expect(config.token).toBe("x");
	});

	test("WARREN_BIND_SOCKET wins over host/port", () => {
		const config = loadServerConfigFromEnv({
			env: {
				WARREN_API_TOKEN: "x",
				WARREN_BIND_SOCKET: "/tmp/warren.sock",
				WARREN_BIND_PORT: "9000",
			},
		});
		expect(config.transport.kind).toBe("unix");
		if (config.transport.kind === "unix") {
			expect(config.transport.path).toBe("/tmp/warren.sock");
		}
	});

	test("custom data dir threads through to db path", () => {
		const config = loadServerConfigFromEnv({
			env: { WARREN_API_TOKEN: "x", WARREN_DATA_DIR: "/var/lib/warren" },
		});
		expect(config.dataDir).toBe("/var/lib/warren");
		expect(config.dbPath).toBe("/var/lib/warren/warren.db");
	});

	test("explicit WARREN_DB_PATH wins over data dir join", () => {
		const config = loadServerConfigFromEnv({
			env: { WARREN_API_TOKEN: "x", WARREN_DB_PATH: "/srv/warren.sqlite" },
		});
		expect(config.dbPath).toBe("/srv/warren.sqlite");
	});

	test("WARREN_DISABLE_UI=1 disables UI", () => {
		const config = loadServerConfigFromEnv({
			env: { WARREN_API_TOKEN: "x", WARREN_DISABLE_UI: "1" },
		});
		expect(config.uiDistDir).toBeNull();
	});

	test("WARREN_UI_DIST_DIR overrides the default", () => {
		const config = loadServerConfigFromEnv({
			env: { WARREN_API_TOKEN: "x", WARREN_UI_DIST_DIR: "/app/ui" },
		});
		expect(config.uiDistDir).toBe("/app/ui");
	});

	test("noAuth=true returns token=null without checking env", () => {
		const config = loadServerConfigFromEnv({ env: {}, noAuth: true });
		expect(config.token).toBeNull();
	});

	test("missing WARREN_API_TOKEN throws when noAuth=false", () => {
		expect(() => loadServerConfigFromEnv({ env: {} })).toThrow(ValidationError);
	});

	test("invalid port throws", () => {
		expect(() =>
			loadServerConfigFromEnv({ env: { WARREN_API_TOKEN: "x", WARREN_BIND_PORT: "70000" } }),
		).toThrow(ValidationError);
	});
});
