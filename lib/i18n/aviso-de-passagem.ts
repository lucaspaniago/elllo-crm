/**
 * Textos fixos do aviso de passagem ao dono e da sondagem (fork elllo).
 *
 * Mesma regra do dicionário: a CHAVE é o texto em português, e falta de
 * tradução degrada para português. Mora num arquivo próprio — espalhado no
 * `DICIONARIO` como `TEXTOS_AGENDA_SERVICOS` — para o fork não tocar as
 * dezesseis mil linhas do dicionário a cada rebase. Chave que já existe lá
 * ("Motivo", "Cliente", "Abrir", "enviada", "respondeu") NÃO se repete aqui.
 */
export const TEXTOS_AVISO_DE_PASSAGEM = {
  "atendimento passou para você": { es: "la atención pasó a ti" },
  "Mensagem que disparou": { es: "Mensaje que lo activó" },
  "Contexto": { es: "Contexto" },
  "Sondagem": { es: "Pregunta de sondeo" },
  "sem resposta em": { es: "sin respuesta en" },
  "Avaliação da IA": { es: "Evaluación de la IA" },
  "provável": { es: "probable" },
  "Indícios": { es: "Indicios" },
  "Recomendação": { es: "Recomendación" },
  "Avaliação indisponível": { es: "Evaluación no disponible" },
  "brincadeira": { es: "broma" },
  "irritação real": { es: "irritación real" },
  "engano": { es: "equivocación" },
  "outro motivo": { es: "otro motivo" },
};
