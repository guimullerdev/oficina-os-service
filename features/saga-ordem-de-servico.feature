# language: pt
Funcionalidade: Saga da ordem de servico

  Cenário: Orçamento reprovado compensa a saga
    Dado que existe uma ordem de serviço aguardando aprovação do orçamento
    Quando o billing publica o evento "orcamento.reprovado" para a ordem de serviço
    Então a ordem de serviço fica com status "REPROVADA"
    E o passo "APROVAR_ORCAMENTO" da saga fica "COMPENSADO"

  Cenário: Caminho feliz conclui a saga e finaliza a OS
    Dado que existe uma ordem de serviço aguardando aprovação do orçamento
    Quando o billing publica o evento "orcamento.aprovado" para a ordem de serviço
    Então o passo "APROVAR_ORCAMENTO" da saga fica "CONCLUIDO"
    E a ordem de serviço fica com status "APROVADA"
    Quando a execução publica o evento "execucao.iniciada" para a ordem de serviço
    Então a ordem de serviço fica com status "EM_EXECUCAO"
    Quando a execução publica o evento "execucao.concluida" para a ordem de serviço
    Então o passo "EXECUTAR" da saga fica "CONCLUIDO"
    E a ordem de serviço fica com status "FINALIZADA"
    Quando o billing publica somente o evento "pagamento.confirmado" para a ordem de serviço
    Então a saga fica "CONCLUIDA"
    E todos os passos da saga ficam "CONCLUIDO"
