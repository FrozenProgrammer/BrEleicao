# BR Eleições 2026

## Executar localmente

1. Mantenha os quatro arquivos desta pasta juntos.
2. Execute:

```bash
node brazil-eleicoes-2026-server.js
```

3. Abra:

`http://localhost:8000/brazil-eleicoes-2026.html`

## Esta iteração

- Mantém a versão anterior como base.
- Remove o filtro de Seção somente da interface e da lógica do navegador.
- Mantém a implementação de Seção no servidor para uso futuro.
- Mantém Estado → Cidade → Zona → Bairro.
- Mantém a seção Gráficos.
- Os gráficos usam os mesmos dados e recortes do painel.
- Top 5 candidatos em Pizza e Barra.
- Top 5 partidos em Barra, agregando os votos dos candidatos por partido.
- Paleta dos gráficos com cores variadas.
- CSS permanece separado do HTML.

## Preparação de produção

Veja `README-production.md` para a versão 2.9.0, configuração por ambiente, HTTPS, health check e encerramento gracioso.


Para o endurecimento e implantação simples em domínio, veja `README-production.md`.
