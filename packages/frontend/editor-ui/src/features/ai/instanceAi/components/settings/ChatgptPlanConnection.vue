<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { InstanceAiChatgptPlanStatus, InstanceAiChatgptPlanModel } from '@n8n/api-types';
import {
	N8nButton,
	N8nCallout,
	N8nInputLabel,
	N8nOption,
	N8nSelect,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { TIME } from '@/app/constants/durations';
import { useInstanceAiSettingsStore } from '../../instanceAiSettings.store';
import {
	fetchChatgptPlanStatus,
	startChatgptPlanSignIn,
	fetchChatgptPlanModels,
	selectChatgptPlanModel,
} from '../../instanceAi.settings.api';

const emit = defineEmits<{ ready: [value: boolean] }>();
const i18n = useI18n();
const root = useRootStore();
const store = useInstanceAiSettingsStore();
const status = ref<InstanceAiChatgptPlanStatus>();
const models = ref<InstanceAiChatgptPlanModel[]>([]);
const model = ref('');
const loading = ref(true);
const signingIn = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let active = true;
let generation = 0;
const connected = computed(
	() => status.value?.authenticated === true && status.value.plan_authorized,
);
const ready = computed(
	() =>
		!signingIn.value &&
		!status.value?.sign_in_pending &&
		connected.value &&
		models.value.some(({ slug }) => slug === model.value),
);
const statusText = computed(() => {
	if (loading.value) return i18n.baseText('instanceAi.chatgpt.checking');
	if (status.value?.reauthorization_required) return i18n.baseText('instanceAi.chatgpt.expired');
	if (connected.value) return i18n.baseText('instanceAi.chatgpt.connected');
	if (status.value?.authenticated) return i18n.baseText('instanceAi.chatgpt.notAuthorized');
	return i18n.baseText('instanceAi.chatgpt.disconnected');
});

async function refresh(): Promise<void> {
	const current = ++generation;
	try {
		const next = await fetchChatgptPlanStatus(root.restApiContext);
		if (!active || current !== generation) return;
		status.value = next;
		if (signingIn.value && !next.sign_in_pending) signingIn.value = false;
		if (next.authenticated && next.plan_authorized) {
			const catalog = await fetchChatgptPlanModels(root.restApiContext);
			if (!active || current !== generation) return;
			models.value = catalog.models;
			if (!models.value.some(({ slug }) => slug === model.value))
				model.value = models.value.some(({ slug }) => slug === next.model)
					? next.model
					: (models.value[0]?.slug ?? '');
		} else {
			models.value = [];
		}
		error.value = '';
	} catch {
		if (!active || current !== generation) return;
		models.value = [];
		error.value = i18n.baseText('instanceAi.chatgpt.checkFailed');
	} finally {
		if (active && current === generation) {
			loading.value = false;
			emit('ready', ready.value);
			if (signingIn.value)
				timer = setTimeout(() => {
					void refresh();
				}, 2 * TIME.SECOND);
		}
	}
}

async function signIn(): Promise<void> {
	const popup = window.open('about:blank', '_blank');
	if (!popup) {
		error.value = i18n.baseText('instanceAi.chatgpt.popupBlocked');
		return;
	}
	popup.opener = null;
	signingIn.value = true;
	emit('ready', false);
	error.value = '';
	clearTimeout(timer);
	++generation;
	try {
		const result = await startChatgptPlanSignIn(root.restApiContext);
		const url = new URL(result.url);
		if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize')
			throw new Error('Invalid sign-in address');
		popup.location.replace(url.href);
		if (active)
			timer = setTimeout(() => {
				void refresh();
			}, 2 * TIME.SECOND);
	} catch {
		popup.close();
		signingIn.value = false;
		error.value = i18n.baseText('instanceAi.chatgpt.startFailed');
	}
}

async function save(): Promise<boolean> {
	if (!ready.value) return false;
	try {
		await selectChatgptPlanModel(root.restApiContext, model.value);
		return await store.fetch();
	} catch {
		error.value = i18n.baseText('instanceAi.chatgpt.saveFailed');
		return false;
	}
}
defineExpose({ save });
onMounted(() => {
	void refresh();
});
onUnmounted(() => {
	active = false;
	++generation;
	clearTimeout(timer);
});
</script>

<template>
	<div :class="$style.fields" data-test-id="assistant-chatgpt-connection">
		<N8nInputLabel
			:label="i18n.baseText('instanceAi.onboarding.model.provider')"
			input-name="assistant-chatgpt-provider"
		>
			<N8nSelect
				id="assistant-chatgpt-provider"
				model-value="chatgpt-plan"
				:teleported="false"
				disabled
			>
				<N8nOption value="chatgpt-plan" :label="i18n.baseText('instanceAi.chatgpt.provider')" />
			</N8nSelect>
		</N8nInputLabel>
		<N8nText tag="p">{{ i18n.baseText('instanceAi.chatgpt.description') }}</N8nText>
		<N8nText tag="p" role="status" aria-live="polite" data-test-id="assistant-chatgpt-status">{{
			statusText
		}}</N8nText>
		<N8nButton
			data-test-id="assistant-chatgpt-sign-in"
			:disabled="signingIn"
			:label="
				i18n.baseText(connected ? 'instanceAi.chatgpt.reconnect' : 'instanceAi.chatgpt.signIn')
			"
			@click="signIn"
		/>
		<N8nText v-if="signingIn" tag="p">{{ i18n.baseText('instanceAi.chatgpt.waiting') }}</N8nText>
		<N8nInputLabel
			v-if="models.length"
			:label="i18n.baseText('instanceAi.onboarding.model.model')"
			input-name="assistant-chatgpt-model"
		>
			<N8nSelect
				id="assistant-chatgpt-model"
				v-model="model"
				:teleported="false"
				data-test-id="assistant-chatgpt-model"
				@update:model-value="emit('ready', ready)"
			>
				<N8nOption
					v-for="item in models"
					:key="item.slug"
					:value="item.slug"
					:label="item.display_name ?? item.slug"
				/>
			</N8nSelect>
		</N8nInputLabel>
		<N8nCallout v-if="error" theme="danger" role="alert">{{ error }}</N8nCallout>
		<N8nButton
			variant="ghost"
			:label="i18n.baseText('instanceAi.chatgpt.refresh')"
			:disabled="loading"
			@click="refresh"
		/>
	</div>
</template>

<style module>
.fields {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}
</style>
