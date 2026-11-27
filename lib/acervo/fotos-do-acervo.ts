/**
 * AS FOTOS DO ACERVO — conferência dos bytes, sem reduzir nada aqui (fork elllo, acervo1).
 *
 * O contêiner do app não leva o binário `sharp` (ver `next.config`: "evita exigir o binário
 * `sharp` no runtime"), então o CRM NÃO reduz a foto: quem manda (o mensageiro do Hermes)
 * reduz para 1600 px no lado maior antes de enviar, e o CRM confere. Foto maior que isso, ou
 * com mais de `FOTO_BYTES_MAXIMO`, volta recusada com o motivo — nunca é gravada torta.
 *
 * Formato pela ASSINATURA dos bytes (`farejarTipo`, o mesmo do catálogo): só JPEG e PNG.
 * As dimensões saem do cabeçalho do arquivo (IHDR do PNG, SOFn do JPEG), sem decodificar.
 */
import { farejarTipo, type TipoDeLogo } from "@/lib/branding/logo-arquivo";

export const FOTO_LADO_MAXIMO = 1600;
/** 800 KB: folga sobre os 150–250 KB de uma foto de 1600 px bem comprimida. */
export const FOTO_BYTES_MAXIMO = 800 * 1024;
/** O mesmo `cardinality(fotos) <= 5` de `catalog_products`. */
export const FOTOS_POR_PECA = 5;

export type ConferenciaDaFoto =
  | { ok: true; tipo: TipoDeLogo; largura: number; altura: number }
  | { ok: false; erro: "foto_invalida" | "foto_grande"; detalhe: string };

function u16(b: Uint8Array, i: number): number {
  return (b[i]! << 8) | b[i + 1]!;
}
function u32(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
}

/** Largura e altura lidas do cabeçalho. `null` = cabeçalho ilegível. */
export function dimensoesDaImagem(bytes: Uint8Array, tipo: TipoDeLogo): { largura: number; altura: number } | null {
  if (tipo === "image/png") {
    // assinatura (8) + tamanho do bloco (4) + "IHDR" (4) + largura (4) + altura (4)
    if (bytes.length < 24) return null;
    const ihdr = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    if (ihdr !== "IHDR") return null;
    return { largura: u32(bytes, 16), altura: u32(bytes, 20) };
  }
  // JPEG: percorre os segmentos até o primeiro SOFn (C0–CF, menos C4, C8 e CC).
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marca = bytes[i + 1]!;
    if (marca === 0xff) {
      i += 1;
      continue;
    }
    if (marca === 0xd8 || marca === 0x01 || (marca >= 0xd0 && marca <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marca === 0xd9 || marca === 0xda) return null;
    const tamanho = u16(bytes, i + 2);
    if (tamanho < 2) return null;
    if (marca >= 0xc0 && marca <= 0xcf && marca !== 0xc4 && marca !== 0xc8 && marca !== 0xcc) {
      return { altura: u16(bytes, i + 5), largura: u16(bytes, i + 7) };
    }
    i += 2 + tamanho;
  }
  return null;
}

export function conferirFoto(bytes: Uint8Array): ConferenciaDaFoto {
  const tipo = farejarTipo(bytes);
  if (!tipo) return { ok: false, erro: "foto_invalida", detalhe: "A foto precisa ser JPG ou PNG." };
  if (bytes.length > FOTO_BYTES_MAXIMO) {
    return { ok: false, erro: "foto_grande", detalhe: `A foto tem ${Math.round(bytes.length / 1024)} KB; o máximo é ${FOTO_BYTES_MAXIMO / 1024} KB. Reduza para ${FOTO_LADO_MAXIMO} px no lado maior.` };
  }
  const d = dimensoesDaImagem(bytes, tipo);
  if (!d || d.largura <= 0 || d.altura <= 0) return { ok: false, erro: "foto_invalida", detalhe: "Não deu para ler o tamanho da foto." };
  if (Math.max(d.largura, d.altura) > FOTO_LADO_MAXIMO) {
    return { ok: false, erro: "foto_grande", detalhe: `A foto tem ${d.largura}x${d.altura} px; o máximo é ${FOTO_LADO_MAXIMO} px no lado maior.` };
  }
  return { ok: true, tipo, ...d };
}
