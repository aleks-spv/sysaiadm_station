import { expect, test } from "bun:test";
import { maskSecrets } from "./mask";

test("masks assignments in env, ini, yaml, json and flags", () => {
  const input = [
    "DB_PASSWORD=hunter2",
    "api_key: 'abc def'",
    '  "client_secret": "s3cr3t",',
    "mysql --password=Qwerty123 -u root",
    "PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=",
  ].join("\n");
  const { text, count } = maskSecrets(input);
  expect(text).toBe(
    ["DB_PASSWORD=***", "api_key: '***'", '  "client_secret": "***",', "mysql --password=*** -u root", "PrivateKey = ***"].join("\n"),
  );
  expect(count).toBe(5);
});

test("leaves sysadmin settings and env that only look like secrets", () => {
  const input = ["PasswordAuthentication no", "PWD=/root", "max_tokens=100", "password:", "  nested: value", "http://host:8080/path"].join("\n");
  expect(maskSecrets(input)).toEqual({ text: input, count: 0 });
});

test("masks PEM keys, cut-off ones included, keeping the markers", () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
  expect(maskSecrets(`a\n${key}\nb`).text).toBe("a\n-----BEGIN OPENSSH PRIVATE KEY-----\n***\n-----END OPENSSH PRIVATE KEY-----\nb");
  expect(maskSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n[output truncated]").text).toBe("-----BEGIN RSA PRIVATE KEY-----\n***\n");
  // Public keys and certificates stay.
  const cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
  expect(maskSecrets(cert).count).toBe(0);
});

test("masks tokens, URL credentials, auth headers and shadow hashes", () => {
  const { text } = maskSecrets(
    [
      "export GH=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
      "postgres://app:pa55@db:5432/app",
      "Authorization: Bearer abcdefghijklmnop",
      "root:$6$salt$abcdefHASH:19000:0:99999:7:::",
      "key AKIAIOSFODNN7EXAMPLE",
    ].join("\n"),
  );
  expect(text).toBe(["export GH=***", "postgres://app:***@db:5432/app", "Authorization: Bearer ***", "root:***:19000:0:99999:7:::", "key ***"].join("\n"));
});

test("masked text is stable on a second pass", () => {
  const once = maskSecrets("token=abc password: \"x\"").text;
  expect(maskSecrets(once)).toEqual({ text: once, count: 0 });
});
