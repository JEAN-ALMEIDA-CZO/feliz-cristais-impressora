# Feliz Cristais Gestão

Aplicativo para Windows e Mac da loja **Feliz Cristais** (a partir da versão 2.0; antes se chamava *Feliz Cristais Impressora*).

- Abre o **painel da loja** numa janela própria, com o login guardado.
- **Avisa na hora** com notificações do sistema e som: pedido novo, pagamento aprovado, cliente esperando no chat, mensagem do site, agradecimentos a enviar.
- Mostra o **número de pendências** no ícone (barra de tarefas no Windows, Dock no Mac) e no ícone ao lado do relógio.
- Menu ao lado do relógio com atalhos: Pedidos, Atendimento, Retiradas na loja, Relatórios.
- **Imprime sozinho** o cupom de cada pedido na impressora escolhida (térmica 58/80 mm ou comum), sem janela de confirmação.
- Inicia junto com o computador e **atualiza sozinho** quando sai uma versão nova aqui no GitHub.

Quem já usa a versão *Impressora* recebe a 2.0 automaticamente; a configuração (site, chave e impressora) continua a mesma.

## Instalar

Baixe a versão mais nova em **Releases**:

- Windows: `Feliz-Cristais-Gestao-Setup.exe`
- Mac: `Feliz-Cristais-Gestao-Mac.dmg`

Depois de instalar, abra o aplicativo e preencha:

1. **Endereço do site** da loja (ex.: `https://www.felizcristais.com.br`).
2. **Chave de impressão**: no painel da loja, em *Impressão de pedidos › Aplicativo de impressão*.
3. **Impressora**: escolha na lista (ou deixe a padrão do sistema).

Clique em **Salvar e conectar** e depois em **Imprimir teste**.

> **Primeira abertura**
> - Windows: se aparecer "O Windows protegeu o computador", clique em *Mais informações › Executar assim mesmo*.
> - Mac: botão direito no aplicativo › *Abrir* › *Abrir*.
>
> Esses avisos aparecem porque o aplicativo ainda não tem certificado de desenvolvedor (pago) da Microsoft/Apple.
> No Mac, a atualização automática exige que o aplicativo seja assinado com uma conta de desenvolvedor Apple;
> até lá, para atualizar no Mac basta baixar e instalar a versão nova por cima.

## Como funciona

O aplicativo consulta a fila de impressão do site (`/admin/print_api.php`) a cada poucos segundos usando a chave
de impressão. Quando chega um pedido, recebe o cupom pronto em HTML, imprime e avisa o site que imprimiu.
A chave só dá acesso à fila de impressão. Se um computador for perdido, gere uma chave nova no painel.

## Lançar uma versão nova

1. Mude `version` no `package.json` (ex.: `1.0.1`).
2. Faça commit e crie a tag com o mesmo número: `git tag v1.0.1 && git push --follow-tags`.
3. O GitHub Actions compila Windows e Mac e publica em Releases. Os aplicativos instalados se atualizam sozinhos.

## Desenvolvimento

```bash
npm install
npm start          # abre o aplicativo
npm run dist       # gera os instaladores na pasta dist/
```
