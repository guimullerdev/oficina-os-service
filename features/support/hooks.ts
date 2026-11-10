import { setDefaultTimeout } from '@cucumber/cucumber';
import { pollTimeoutMs } from './polling';

// O timeout do step precisa caber o polling inteiro; quem falha primeiro é o
// polling, com a mensagem do último estado.
setDefaultTimeout(pollTimeoutMs() + 15000);
