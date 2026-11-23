/**
 * O vocabulário do apanhado das 7h ao dono (fork elllo, migration 9004).
 *
 * Os CHECK de `itens_do_apanhado` aceitam EXATAMENTE estas tuplas — quem
 * confere é `tests/invariants/apanhado-do-dono.test.ts`. Arquivo sem import de
 * ambiente: o teste do banco o lê sem subir nada.
 */

/** O que o item é: propaganda silenciada ou mensagem de grupo que vale resposta. */
export const TIPOS_DO_ITEM = ["propaganda", "grupo"] as const;
export type TipoDoItem = (typeof TIPOS_DO_ITEM)[number];

/** Quem decidiu: a forma do disparo (sem modelo) ou o Jev. */
export const ORIGENS_DO_ITEM = ["disparo_automatico", "jev"] as const;
export type OrigemDoItem = (typeof ORIGENS_DO_ITEM)[number];
