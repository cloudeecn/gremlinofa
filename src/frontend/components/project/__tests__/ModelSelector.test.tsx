import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { APIDefinition, Model } from '../../../../shared/protocol/types';

const apiDefinitions: APIDefinition[] = [
  {
    id: 'api_a',
    name: 'Provider A',
    apiType: 'chatgpt',
    apiKey: 'sk-a',
    baseUrl: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'api_b',
    name: 'Provider B',
    apiType: 'anthropic',
    apiKey: 'sk-b',
    baseUrl: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];
const models = new Map<string, Model[]>([
  ['api_a', [{ id: 'model_a', name: 'Model A', apiType: 'chatgpt' } as Model]],
  ['api_b', [{ id: 'model_b', name: 'Model B', apiType: 'anthropic' } as Model]],
]);

vi.mock('../../../hooks/useApp', () => ({
  useApiDefinitions: () => apiDefinitions,
  useModels: () => models,
}));

import ModelSelector from '../ModelSelector';

function renderSelector(showResetOption: boolean) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <ModelSelector
      isOpen
      onClose={onClose}
      currentApiDefinitionId="api_a"
      currentModelId="model_a"
      onSelect={onSelect}
      title="Select Model"
      showResetOption={showResetOption}
    />
  );
  return { onSelect, onClose };
}

describe('ModelSelector', () => {
  it.each([true, false])(
    'disables Apply after a provider change until a model is picked (reset option: %s)',
    showResetOption => {
      const { onSelect } = renderSelector(showResetOption);
      const apply = screen.getByRole('button', { name: 'Apply' });
      expect(apply).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: /Provider A/ }));
      fireEvent.click(screen.getByRole('button', { name: /Provider B/ }));
      expect(apply).toBeDisabled();
      fireEvent.click(apply);
      expect(onSelect).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /Model B/ }));
      expect(apply).toBeEnabled();
      fireEvent.click(apply);
      expect(onSelect).toHaveBeenCalledWith('api_b', 'model_b');
    }
  );

  it('still lets Remove fall back to the parent model', () => {
    const { onSelect } = renderSelector(true);
    fireEvent.click(screen.getByRole('button', { name: /Provider A/ }));
    fireEvent.click(screen.getByRole('button', { name: /Provider B/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onSelect).toHaveBeenCalledWith(null, null);
  });
});
