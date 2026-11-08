/**
 * Textos fixos do aviso de passagem ao dono e da nota de tom áspero (fork elllo).
 *
 * Mesma regra do dicionário: a CHAVE é o texto em português, e falta de
 * tradução degrada para português. Mora num arquivo próprio — espalhado no
 * `DICIONARIO` como `TEXTOS_AGENDA_SERVICOS` — para o fork não tocar as
 * dezesseis mil linhas do dicionário a cada rebase. Chave que já existe lá
 * ("Motivo", "Cliente", "Mensagem", "Abrir") NÃO se repete aqui.
 */
export const TEXTOS_AVISO_DE_PASSAGEM = {
  "atendimento passou para você": { es: "la atención pasó a ti" },
  "Mensagem que disparou": { es: "Mensaje que lo activó" },
  "Contexto": { es: "Contexto" },
  "Avaliação da IA": { es: "Evaluación de la IA" },
  "provável": { es: "probable" },
  "Indícios": { es: "Indicios" },
  "Recomendação": { es: "Recomendación" },
  "Avaliação indisponível": { es: "Evaluación no disponible" },
  "brincadeira": { es: "broma" },
  "irritação real": { es: "irritación real" },
  "engano": { es: "equivocación" },
  "outro motivo": { es: "otro motivo" },
  // A nota de tom áspero (lib/escalacao/tolerancia-ao-sentimento.ts).
  "tom áspero, segui atendendo": { es: "tono áspero, seguí atendiendo" },
};
