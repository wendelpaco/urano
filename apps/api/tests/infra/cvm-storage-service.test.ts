import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import {
  CvmStorageService,
  decodeCvmCsv,
  isLatestCvmExercise,
} from '../../src/infra/services/cvm-storage-service.ts';

class FixtureCvmStorageService extends CvmStorageService {
  constructor(private readonly fixture: ArrayBuffer) {
    super();
  }

  protected override async downloadZip(): Promise<ArrayBuffer> {
    return this.fixture;
  }
}

async function petr4LikeZip(): Promise<ArrayBuffer> {
  const encodeLatin1 = (value: string): Uint8Array => Uint8Array.from(
    [...value].map((character) => {
      const code = character.charCodeAt(0);
      if (code > 0xff) throw new Error(`Fixture não representável em Latin-1: ${character}`);
      return code;
    }),
  );
  const header = [
    'CNPJ_CIA',
    'DT_REFER',
    'DENOM_CIA',
    'ESCALA_MOEDA',
    'ORDEM_EXERC',
    'DT_INI_EXERC',
    'DT_FIM_EXERC',
    'CD_CONTA',
    'DS_CONTA',
    'VL_CONTA',
  ].join(';');
  const row = (
    order: string,
    endDate: string,
    account: string,
    description: string,
    value: number,
  ) => [
    '33.000.167/0001-01',
    '2024-12-31',
    'PETRÓLEO BRASILEIRO S.A. PETROBRAS',
    'UNIDADE',
    order,
    `${endDate.slice(0, 4)}-01-01`,
    endDate,
    account,
    description,
    String(value),
  ].join(';');

  const csv = [
    header,
    // Ú é byte 0xDA no ZIP real da CVM (Windows-1252/Latin-1), não UTF-8.
    row('ÚLTIMO', '2024-12-31', '3.11', 'Lucro Líquido', 1_000),
    row('ÚLTIMO', '2024-12-31', '3.01', 'Receita', 10_000),
    // Comparativo presente no mesmo ZIP: nunca pode virar fiscalYear 2024.
    row('PENÚLTIMO', '2023-12-31', '3.11', 'Lucro Líquido', 999_999),
    row('PENÚLTIMO', '2023-12-31', '3.01', 'Receita', 9_999_999),
  ].join('\n');

  const zip = new JSZip();
  zip.file('dfp_cia_aberta_DRE_con_2024.csv', encodeLatin1(csv));
  zip.file(
    'dfp_cia_aberta_BPA_con_2024.csv',
    encodeLatin1([
      header,
      row('ÚLTIMO', '2024-12-31', '1', 'Ativo Total', 20_000),
      row('ÚLTIMO', '2024-12-31', '1.01', 'Ativo Circulante', 9_999),
      row('ÚLTIMO', '2024-12-31', '1.01.01', 'Caixa e Equivalentes', 250),
    ].join('\n')),
  );
  const dmplHeader = `${header};COLUNA_DF`;
  zip.file(
    'dfp_cia_aberta_DMPL_con_2024.csv',
    encodeLatin1([
      dmplHeader,
      `${row('ÚLTIMO', '2024-12-31', '5.04.06', 'Dividendos', -100)};Patrimônio Líquido Consolidado`,
      `${row('ÚLTIMO', '2024-12-31', '5.04.07', 'Juros sobre Capital Próprio', -20)};Patrimônio Líquido Consolidado`,
    ].join('\n')),
  );
  zip.file(
    'dfp_cia_aberta_composicao_capital_2024.csv',
    encodeLatin1([
      'CNPJ_CIA;QT_ACAO_TOTAL_CAP_INTEGR',
      '33.000.167/0001-01;93170747',
    ].join('\n')),
  );
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('CvmStorageService — exercício corrente', () => {
  test('normaliza ÚLTIMO com acento composto/decomposto e rejeita comparativo', () => {
    expect(isLatestCvmExercise(' ÚLTIMO ')).toBe(true);
    expect(isLatestCvmExercise('U\u0301LTIMO')).toBe(true);
    expect(isLatestCvmExercise('PENÚLTIMO')).toBe(false);
    expect(isLatestCvmExercise('')).toBe(false);
  });

  test('decodifica bytes Latin-1 reais sem produzir caractere de substituição', () => {
    const bytes = Uint8Array.from([0xda, 0x4c, 0x54, 0x49, 0x4d, 0x4f]);
    const decoded = decodeCvmCsv(bytes);
    expect(decoded).toBe('ÚLTIMO');
    expect(decoded).not.toContain('�');
  });

  test('fixture PETR4-like não persiste PENÚLTIMO como o mesmo fiscalYear', async () => {
    const service = new FixtureCvmStorageService(await petr4LikeZip());
    const result = await service.fetchAndParseCvmDataBatch(
      2024,
      ['33000167000101'],
    );
    const fundamentals = result.get('33000167000101') ?? [];

    expect(fundamentals).toHaveLength(1);
    expect(fundamentals[0]).toMatchObject({
      cnpj: '33000167000101',
      referenceDate: '2024-12-31',
      fiscalYear: 2024,
      netIncome: 1_000,
      revenue: 10_000,
      totalAssets: 20_000,
      cash: 250,
      dividendsPaid: 100,
      jcpPaid: 20,
      sharesOutstanding: 93_170_747,
      source: 'DFP',
    });
    expect(fundamentals.some((item) => item.referenceDate === '2023-12-31')).toBe(false);
    expect(fundamentals.some((item) => item.netIncome === 999_999)).toBe(false);
  });
});
