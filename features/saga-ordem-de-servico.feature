# language: pt
Funcionalidade: Saga da ordem de servico

  Cenário: Orçamento reprovado compensa a saga
    Dado que existe uma ordem de serviço aguardando aprovação do orçamento
    Quando o billing publica o evento "orcamento.reprovado" para a ordem de serviço
    Então a ordem de serviço fica com status "REPROVADA"
    E o passo "APROVAR_ORCAMENTO" da saga fica "COMPENSADO"
