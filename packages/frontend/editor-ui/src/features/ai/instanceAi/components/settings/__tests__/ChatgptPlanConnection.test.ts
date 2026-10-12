import { createTestingPinia } from '@pinia/testing';
import { fireEvent, waitFor } from '@testing-library/vue';
import { setActivePinia } from 'pinia';
import { mock } from 'vitest-mock-extended';
import {
	DEFAULT_INSTANCE_AI_PERMISSIONS,
	type InstanceAiAdminSettingsResponse,
} from '@n8n/api-types';
import { createComponentRenderer } from '@/__tests__/render';
import { useInstanceAiSettingsStore } from '../../../instanceAiSettings.store';
import * as api from '../../../instanceAi.settings.api';
import Wizard from '../../../onboarding/InstanceAiOnboardingWizard.vue';

vi.mock('@n8n/i18n', async (importOriginal) => ({
	...(await importOriginal()),
	useI18n: () => ({ baseText: (key: string) => key }),
}));
vi.mock('@/app/stores/pushConnection.store', () => ({
	usePushConnectionStore: () => ({ addEventListener: vi.fn() }),
}));
vi.mock('@/app/utils/rbac/permissions', () => ({ hasPermission: vi.fn().mockReturnValue(true) }));
vi.mock('../../../instanceAi.settings.api', async (importOriginal) => ({
	...(await importOriginal()),
	fetchChatgptPlanStatus: vi.fn(),
	fetchChatgptPlanModels: vi.fn(),
	startChatgptPlanSignIn: vi.fn(),
	selectChatgptPlanModel: vi.fn(),
}));
const disconnected = {
	authenticated: false,
	plan_authorized: false,
	reauthorization_required: false,
	model: 'gpt-fixture',
};
const connected = { ...disconnected, authenticated: true, plan_authorized: true };
const renderWizard = createComponentRenderer(Wizard, {
	props: {
		open: true,
		step: 'model',
		editMode: true,
		sequence: ['model', 'sandbox', 'search', 'done'],
		modelValue: '',
		sandboxValue: '',
		searchValue: '',
		composeFastPath: false,
		surface: 'settings',
	},
});
function setup() {
	const pinia = createTestingPinia();
	setActivePinia(pinia);
	const store = useInstanceAiSettingsStore();
	const settings: InstanceAiAdminSettingsResponse = {
		enabled: true,
		permissions: DEFAULT_INSTANCE_AI_PERMISSIONS,
		mcpAccessEnabled: true,
		sandboxEnabled: true,
		sandboxProvider: 'n8n-sandbox',
		daytonaCredentialId: null,
		n8nSandboxCredentialId: null,
		searchCredentialId: null,
		modelCredentialId: null,
		modelName: null,
		modelEnvConfigured: true,
		sandboxEnvConfigured: true,
		searchEnvConfigured: false,
		searchDisabled: true,
		n8nSandboxServiceUrl: null,
		envManaged: {
			model: { provider: true, apiKey: true, baseUrl: true, model: true },
			sandbox: { provider: true, serviceUrl: true, apiKey: true },
			search: { provider: false, apiKey: false, url: false },
		},
		localGatewayDisabled: true,
		browserUseEnabled: false,
		chatgptPlan: disconnected,
	};
	store.$patch({ settings });
	vi.mocked(store.fetch).mockResolvedValue(true);
	return { store, ...renderWizard({ pinia }) };
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(api.fetchChatgptPlanStatus).mockResolvedValue(disconnected);
	vi.mocked(api.fetchChatgptPlanModels).mockResolvedValue({
		models: [{ slug: 'gpt-fixture', display_name: 'Fixture model' }],
	});
	vi.mocked(api.selectChatgptPlanModel).mockResolvedValue({ model: 'gpt-fixture' });
	vi.mocked(api.startChatgptPlanSignIn).mockResolvedValue({
		url: 'https://auth.openai.com/api/accounts/authorize?state=fixture',
	});
});
afterEach(() => {
	vi.useRealTimers();
});

it('shows ChatGPT sign-in inside the native model dialog despite locked environment fields', async () => {
	const { findByTestId, getByTestId, queryByTestId } = setup();
	expect(await findByTestId('assistant-chatgpt-sign-in')).toHaveTextContent(
		'instanceAi.chatgpt.signIn',
	);
	await waitFor(() =>
		expect(getByTestId('assistant-chatgpt-status')).toHaveTextContent(
			'instanceAi.chatgpt.disconnected',
		),
	);
	expect(getByTestId('n8n-agent-model-dialog-save')).toBeDisabled();
	expect(queryByTestId('n8n-agent-model-api-key-input')).not.toBeInTheDocument();
	expect(api.fetchChatgptPlanModels).not.toHaveBeenCalled();
});
it('saves a catalog model through the native endpoint and advances without an API-key probe', async () => {
	vi.mocked(api.fetchChatgptPlanStatus).mockResolvedValue(connected);
	const { store, getByTestId, emitted } = setup();
	await waitFor(() => expect(getByTestId('n8n-agent-model-dialog-save')).toBeEnabled());
	await fireEvent.click(getByTestId('n8n-agent-model-dialog-save'));
	await waitFor(() => expect(emitted().advance).toHaveLength(1));
	expect(api.selectChatgptPlanModel).toHaveBeenCalledWith(expect.anything(), 'gpt-fixture');
	expect(store.verifyModel).not.toHaveBeenCalled();
	expect(store.loadModelCatalog).not.toHaveBeenCalled();
});
it('keeps Save disabled when an authenticated account cannot load plan models', async () => {
	vi.mocked(api.fetchChatgptPlanStatus).mockResolvedValue(connected);
	vi.mocked(api.fetchChatgptPlanModels).mockRejectedValue(new Error('Fixture rejection'));
	const { getByTestId, findByRole } = setup();
	expect(await findByRole('alert')).toHaveTextContent('instanceAi.chatgpt.checkFailed');
	expect(getByTestId('n8n-agent-model-dialog-save')).toBeDisabled();
});
it('reports a blocked sign-in tab without starting OAuth', async () => {
	vi.spyOn(window, 'open').mockReturnValue(null);
	const { findByTestId, findByRole } = setup();
	await fireEvent.click(await findByTestId('assistant-chatgpt-sign-in'));
	expect(await findByRole('alert')).toHaveTextContent('instanceAi.chatgpt.popupBlocked');
	expect(api.startChatgptPlanSignIn).not.toHaveBeenCalled();
});
it('opens only the validated OpenAI URL and blocks Save while reconnecting an existing account', async () => {
	vi.mocked(api.fetchChatgptPlanStatus).mockResolvedValue(connected);
	const replace = vi.fn();
	const popup = mock<Window>({ location: mock<Location>({ replace }) });
	vi.spyOn(window, 'open').mockReturnValue(popup);
	const { getByTestId } = setup();
	await waitFor(() => expect(getByTestId('n8n-agent-model-dialog-save')).toBeEnabled());
	await fireEvent.click(getByTestId('assistant-chatgpt-sign-in'));
	await waitFor(() =>
		expect(replace).toHaveBeenCalledWith(
			'https://auth.openai.com/api/accounts/authorize?state=fixture',
		),
	);
	expect(popup.opener).toBeNull();
	expect(getByTestId('n8n-agent-model-dialog-save')).toBeDisabled();
});
it('closes the tab and reports an invalid authorization URL', async () => {
	const popup = mock<Window>({ location: mock<Location>({ replace: vi.fn() }), close: vi.fn() });
	vi.spyOn(window, 'open').mockReturnValue(popup);
	vi.mocked(api.startChatgptPlanSignIn).mockResolvedValue({
		url: 'https://example.invalid/collect',
	});
	const { findByTestId, findByRole } = setup();
	await fireEvent.click(await findByTestId('assistant-chatgpt-sign-in'));
	expect(await findByRole('alert')).toHaveTextContent('instanceAi.chatgpt.startFailed');
	expect(popup.close).toHaveBeenCalled();
	expect(popup.location.replace).not.toHaveBeenCalled();
});
it('does not advance if the saved connection cannot refresh n8n settings', async () => {
	vi.mocked(api.fetchChatgptPlanStatus).mockResolvedValue(connected);
	const { store, getByTestId, emitted } = setup();
	vi.mocked(store.fetch).mockResolvedValue(false);
	await waitFor(() => expect(getByTestId('n8n-agent-model-dialog-save')).toBeEnabled());
	await fireEvent.click(getByTestId('n8n-agent-model-dialog-save'));
	await waitFor(() => expect(api.selectChatgptPlanModel).toHaveBeenCalled());
	expect(emitted().advance).toBeUndefined();
});

it('waits for the current sign-in callback before it accepts an existing connection', async () => {
	vi.mocked(api.fetchChatgptPlanStatus).mockResolvedValue(connected);
	const popup = mock<Window>({ location: mock<Location>({ replace: vi.fn() }) });
	vi.spyOn(window, 'open').mockReturnValue(popup);
	const { getByTestId } = setup();
	await waitFor(() => expect(getByTestId('n8n-agent-model-dialog-save')).toBeEnabled());
	vi.useFakeTimers();
	vi.mocked(api.fetchChatgptPlanStatus)
		.mockResolvedValueOnce({ ...connected, sign_in_pending: true })
		.mockResolvedValueOnce({ ...connected, sign_in_pending: false });
	await fireEvent.click(getByTestId('assistant-chatgpt-sign-in'));
	await vi.advanceTimersByTimeAsync(2_000);
	expect(getByTestId('n8n-agent-model-dialog-save')).toBeDisabled();
	await vi.advanceTimersByTimeAsync(2_000);
	expect(getByTestId('n8n-agent-model-dialog-save')).toBeEnabled();
});
it('stops polling when the native dialog closes', async () => {
	const popup = mock<Window>({ location: mock<Location>({ replace: vi.fn() }) });
	vi.spyOn(window, 'open').mockReturnValue(popup);
	const { findByTestId, unmount } = setup();
	const button = await findByTestId('assistant-chatgpt-sign-in');
	await waitFor(() => expect(api.fetchChatgptPlanStatus).toHaveBeenCalledTimes(1));
	vi.useFakeTimers();
	await fireEvent.click(button);
	unmount();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(api.fetchChatgptPlanStatus).toHaveBeenCalledTimes(1);
});
