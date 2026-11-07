import { BRANCH_CODE_PATTERN } from "@erp/contracts";
import { describe, expect, it } from "vitest";
import { BRANCH_CODE, checkBranchCode } from "./branch-code.js";
import { checkCnpj, cnpjRoot, normalizeCnpj } from "./cnpj.js";
import { checkTimezone } from "./timezone.js";

describe("checkCnpj", () => {
  it.each([
    ["numeric", "11222333000181"],
    ["numeric with mask", "11.222.333/0001-81"],
    ["numeric, branch order", "11222333000262"],
    ["numeric, second DV with remainder < 2", "00123456000220"],
    // Exemplo oficial do FAQ da Receita Federal (CNPJ alfanumérico).
    ["alphanumeric (official example)", "12ABC34501DE35"],
    ["alphanumeric with mask", "12.ABC.345/01DE-35"],
    ["alphanumeric, lowercase input", "12abc34501de35"],
    // Primeiro CNPJ alfanumérico emitido pela Receita (31/07/2026).
    ["first alphanumeric issued", "00.000.000/E08G-12"],
  ])("accepts %s", (_, input) => {
    const result = checkCnpj(input);
    expect(result).toEqual({ ok: true, value: normalizeCnpj(input) });
    if (result.ok) expect(result.value).toMatch(/^[0-9A-Z]{12}[0-9]{2}$/);
  });

  it.each([
    ["wrong first DV", "11222333000191", "invalid_cnpj"],
    ["wrong second DV", "11222333000182", "invalid_cnpj"],
    ["alphanumeric with wrong DV", "12ABC34501DE36", "invalid_cnpj"],
    ["repeated digits", "00000000000000", "invalid_cnpj"],
    ["repeated digits (valid mod 11)", "11111111111111", "invalid_cnpj"],
    ["letter in the DV", "12ABC34501DE3A", "invalid_format"],
    ["too short", "1122233300018", "invalid_format"],
    ["too long", "112223330001811", "invalid_format"],
    ["other punctuation", "11222333_000181", "invalid_format"],
    ["non-ASCII digits", "١١٢٢٢٣٣٣٠٠٠١٨١", "invalid_format"],
    ["non-ASCII letter", "12ÁBC34501DE35", "invalid_format"],
    ["empty", "", "invalid_format"],
  ])("rejects %s", (_, input, issue) => {
    expect(checkCnpj(input)).toEqual({ ok: false, issue });
  });

  it("exposes the 8-character root", () => {
    expect(cnpjRoot("11222333000181")).toBe("11222333");
    expect(cnpjRoot("12ABC34501DE35")).toBe("12ABC345");
  });
});

describe("checkTimezone", () => {
  it.each([
    ["America/Sao_Paulo", "America/Sao_Paulo"],
    ["America/Manaus", "America/Manaus"],
    ["america/sao_paulo", "America/Sao_Paulo"],
    ["Brazil/East", "America/Sao_Paulo"],
    ["UTC", "UTC"],
    ["Etc/UTC", "UTC"],
  ])("accepts %s as %s", (input, value) => {
    expect(checkTimezone(input)).toEqual({ ok: true, value });
  });

  it.each(["-03:00", "+00:00", "GMT-3", "UTC-3", "Etc/GMT+3", "Mars/Olympus", "America/Sao_Paulo ", " UTC", "", "x".repeat(65)])(
    "rejects %j",
    (input) => {
      expect(checkTimezone(input)).toEqual({ ok: false });
    },
  );
});

describe("checkBranchCode", () => {
  it.each([
    [" morumbi ", "MORUMBI"],
    ["loja-01", "LOJA-01"],
    ["001", "001"],
    ["a_b", "A_B"],
    ["X".repeat(32), "X".repeat(32)],
  ])("normalizes %j to %s", (input, value) => {
    expect(checkBranchCode(input)).toEqual({ ok: true, value });
  });

  it.each([
    ["", "too_short"],
    ["   ", "too_short"],
    ["X".repeat(33), "too_long"],
    ["-LOJA", "invalid_format"],
    ["LOJA 1", "invalid_format"],
    ["LOJA.1", "invalid_format"],
    ["SÃO", "invalid_format"],
  ])("rejects %j (%s)", (input, issue) => {
    expect(checkBranchCode(input)).toEqual({ ok: false, issue });
  });

  it("matches the pattern published in @erp/contracts", () => {
    expect(BRANCH_CODE.source).toBe(BRANCH_CODE_PATTERN.source);
    expect(BRANCH_CODE.flags).toBe(BRANCH_CODE_PATTERN.flags);
  });
});
