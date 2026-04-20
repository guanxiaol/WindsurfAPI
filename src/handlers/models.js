import { listModels } from '../models.js';

export function handleModels() {
  return { object: 'list', data: listModels() };
}
