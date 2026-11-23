"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { CATEGORIAS_DO_DOSSIE, type CategoriaDoDossie, type FonteDoDossie } from "@/lib/agent-engine/agent/dossie";
import { apiClient } from "@/lib/api/client";

/**
 * O DOSSIÊ DO CONTATO na tela (fork elllo, migration 9005) — a seção "Memória do
 * contato" do painel lateral. O dono lê o que a Helô guardou da pessoa, por categoria
 * e com quem contou, corrige, apaga e escreve o que ele mesmo sabe. O que ele escreve
 * é "você contou": a Helô usa para o tom, mas não repete ao contato a não ser com
 * "pode usar com o contato" ligado.
 */
export type LinhaDoDossieNaTela = {
  id: string;
  headline: string;
  body: string;
  categoria?: CategoriaDoDossie;
  fonte?: FonteDoDossie;
  liberada?: boolean;
};

const ROTULO_DA_CATEGORIA: Record<CategoriaDoDossie, string> = {
  conheceu: "Como se conheceram",
  gostos: "Gostos e assuntos",
  rotina: "Rotina",
  pendente: "Pendente",
  jeito: "Jeito que funciona",
  tom: "Tom entre vocês",
  fato: "Outros fatos",
};

const ROTULO_DA_FONTE: Record<FonteDoDossie, string> = {
  pessoa: "a pessoa contou",
  helo: "observação da Helô",
  lucas: "você contou",
};

type Rascunho = { headline: string; body: string; categoria: CategoriaDoDossie; liberada: boolean };
const VAZIO: Rascunho = { headline: "", body: "", categoria: "fato", liberada: false };

export function DossieDoContato({
  contactId,
  linhas,
  carregando,
  somenteLeitura,
}: {
  contactId: string;
  linhas: LinhaDoDossieNaTela[];
  carregando: boolean;
  somenteLeitura: boolean;
}) {
  const t = useT();
  const [lista, setLista] = useState<LinhaDoDossieNaTela[]>(linhas);
  const [editando, setEditando] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState<Rascunho>(VAZIO);
  const [salvando, setSalvando] = useState(false);
  // A lista do servidor mudou (outro contato, recarga): recomeça dela. Ajuste durante o
  // render, não num efeito (react.dev, "you might not need an effect").
  const [base, setBase] = useState(linhas);
  if (base !== linhas) {
    setBase(linhas);
    setLista(linhas);
  }

  const abrir = (l: LinhaDoDossieNaTela | null) => {
    setEditando(l ? l.id : "nova");
    setRascunho(
      l
        ? { headline: l.headline, body: l.body, categoria: l.categoria ?? "fato", liberada: l.liberada === true }
        : VAZIO,
    );
  };

  const salvar = async () => {
    if (editando === null) return;
    setSalvando(true);
    try {
      if (editando === "nova") {
        const r = await apiClient.post<{ data: LinhaDoDossieNaTela }>(`/api/v1/contacts/${contactId}/dossie`, rascunho);
        setLista((atual) => [r.data, ...atual]);
      } else {
        const atual = lista.find((l) => l.id === editando);
        const corpo = atual?.fonte === "lucas" ? rascunho : { ...rascunho, liberada: undefined };
        const r = await apiClient.patch<{ data: LinhaDoDossieNaTela }>(
          `/api/v1/contacts/${contactId}/dossie/${editando}`,
          corpo,
        );
        setLista((todas) => todas.map((l) => (l.id === editando ? r.data : l)));
      }
      setEditando(null);
      toast.success(t("Dossiê salvo."));
    } catch {
      toast.error(t("Não foi possível salvar a nota."));
    } finally {
      setSalvando(false);
    }
  };

  const apagar = async (id: string) => {
    if (!window.confirm(t("Apagar esta nota do dossiê?"))) return;
    try {
      await apiClient.delete(`/api/v1/contacts/${contactId}/dossie/${id}`);
      setLista((todas) => todas.filter((l) => l.id !== id));
    } catch {
      toast.error(t("Não foi possível apagar a nota."));
    }
  };

  const formulario = (fonte: FonteDoDossie | undefined) => (
    <div className="mt-2 space-y-2 rounded-md border p-2" data-testid="dossie-formulario">
      <select
        aria-label={t("Categoria")}
        className="w-full rounded-md border bg-background px-2 py-1 text-xs"
        value={rascunho.categoria}
        onChange={(e) => setRascunho({ ...rascunho, categoria: e.target.value as CategoriaDoDossie })}
      >
        {CATEGORIAS_DO_DOSSIE.map((c) => (
          <option key={c} value={c}>
            {t(ROTULO_DA_CATEGORIA[c])}
          </option>
        ))}
      </select>
      <Input
        aria-label={t("Título")}
        className="text-xs"
        value={rascunho.headline}
        maxLength={300}
        placeholder={t("Uma linha curta")}
        onChange={(e) => setRascunho({ ...rascunho, headline: e.target.value })}
      />
      <Textarea
        aria-label={t("Texto")}
        className="text-xs"
        value={rascunho.body}
        maxLength={4000}
        onChange={(e) => setRascunho({ ...rascunho, body: e.target.value })}
      />
      {(fonte === undefined || fonte === "lucas") && (
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={rascunho.liberada}
            onCheckedChange={(v) => setRascunho({ ...rascunho, liberada: v })}
          />
          {t("Pode usar com o contato")}
        </label>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={salvando || rascunho.headline.trim() === "" || rascunho.body.trim() === ""}
          onClick={() => void salvar()}
        >
          {t("Salvar")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditando(null)}>
          {t("Cancelar")}
        </Button>
      </div>
    </div>
  );

  if (carregando) return null;
  const porCategoria = CATEGORIAS_DO_DOSSIE.map((c) => ({
    c,
    linhas: lista.filter((l) => (l.categoria ?? "fato") === c),
  })).filter((g) => g.linhas.length > 0);

  return (
    <div data-testid="dossie-do-contato">
      {porCategoria.map((g) => (
        <div key={g.c} className="mt-2">
          <h4 className="text-xs font-medium">{t(ROTULO_DA_CATEGORIA[g.c])}</h4>
          {g.linhas.map((l) => (
            <div key={l.id} className="mt-1 text-xs">
              {editando === l.id ? (
                formulario(l.fonte)
              ) : (
                <details>
                  {/* Uma linha só, com summary e p: a régua 2 de tests/unit/inbox-texto-longo-nao-empurra-a-coluna.test.ts. */}
                  <summary className="wrap-anywhere">{l.headline} {l.fonte && <Badge variant="outline" className="ml-1 text-[10px]">{t(ROTULO_DA_FONTE[l.fonte])}{l.fonte === "lucas" && l.liberada ? ` · ${t("pode usar")}` : ""}</Badge>}</summary><p className="mt-1 whitespace-pre-wrap wrap-anywhere">{l.body}</p>
                  {!somenteLeitura && (
                    <div className="mt-1 flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => abrir(l)}>
                        {t("Corrigir")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void apagar(l.id)}>
                        {t("Apagar")}
                      </Button>
                    </div>
                  )}
                </details>
              )}
            </div>
          ))}
        </div>
      ))}
      {lista.length === 0 && <p className="mt-2 text-xs text-muted-foreground">{t("Nenhum fato durável registrado.")}</p>}
      {!somenteLeitura &&
        (editando === "nova" ? (
          formulario(undefined)
        ) : (
          <Button size="sm" variant="outline" className="mt-2" onClick={() => abrir(null)}>
            {t("Anotar no dossiê")}
          </Button>
        ))}
    </div>
  );
}
