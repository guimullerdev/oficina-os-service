// Arquivo de teste do Quality Gate (Fase 9 T8): função nova SEM spec.
// O PR que o contém existe só para provar que o gate reprova e não deve ser
// mergeado.

const PLACA_ANTIGA = /^[A-Z]{3}[0-9]{4}$/;
const PLACA_MERCOSUL = /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/;
const LETRAS_MERCOSUL = 'ABCDEFGHIJ';

export type TipoPlaca = 'ANTIGA' | 'MERCOSUL' | 'INVALIDA';

export function normalizarPlaca(valor: string): string {
  return valor.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

export function tipoDaPlaca(valor: string): TipoPlaca {
  const placa = normalizarPlaca(valor);
  if (PLACA_ANTIGA.test(placa)) {
    return 'ANTIGA';
  }
  if (PLACA_MERCOSUL.test(placa)) {
    return 'MERCOSUL';
  }
  return 'INVALIDA';
}

export function converterParaMercosul(valor: string): string {
  const placa = normalizarPlaca(valor);
  const tipo = tipoDaPlaca(placa);
  if (tipo === 'MERCOSUL') {
    return placa;
  }
  if (tipo === 'INVALIDA') {
    throw new Error(`Placa inválida: ${valor}`);
  }
  const digito = Number(placa.charAt(4));
  const letra = LETRAS_MERCOSUL.charAt(digito);
  return `${placa.slice(0, 4)}${letra}${placa.slice(5)}`;
}

export function formatarPlaca(valor: string): string {
  const placa = normalizarPlaca(valor);
  const tipo = tipoDaPlaca(placa);
  if (tipo === 'ANTIGA') {
    return `${placa.slice(0, 3)}-${placa.slice(3)}`;
  }
  if (tipo === 'MERCOSUL') {
    return placa;
  }
  throw new Error(`Placa inválida: ${valor}`);
}
