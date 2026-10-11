const statusElement = document.getElementById('status');
const login = document.getElementById('login');
async function signIn() {
	login.disabled = true;
	try {
		const response = await fetch('/auth/start', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		const value = await response.json();
		if (!response.ok) throw new Error(value.error?.message ?? 'Sign-in could not start.');
		window.location.href = value.url;
	} catch (error) {
		statusElement.textContent = error.message;
		login.disabled = false;
	}
}
login.addEventListener('click', () => signIn());
async function loadStatus() {
	const response = await fetch('/auth/status');
	const value = await response.json();
	statusElement.textContent = value.plan_authorized
		? `Connected${value.email ? ` as ${value.email}` : ''}. Selected model: ${value.model}.`
		: value.reauthorization_required
			? 'This connection expired. Sign in again.'
			: value.authenticated
				? 'Identity sign-in succeeded. ChatGPT plan usage is not authorized.'
				: 'Sign in to authorize ChatGPT plan access.';
	if (!value.plan_authorized) return;
	login.textContent = 'Reconnect with ChatGPT';
	const modelResponse = await fetch('/auth/models');
	const modelValue = await modelResponse.json();
	if (!modelResponse.ok) {
		statusElement.textContent += `\n${modelValue.error?.message ?? 'Model access could not be verified.'}`;
		return;
	}
	document.getElementById('model-controls').hidden = false;
	for (const model of modelValue.models) {
		const option = document.createElement('option');
		option.value = model.slug;
		option.textContent = model.display_name ?? model.slug;
		option.selected = model.slug === value.model;
		document.getElementById('model').append(option);
		const item = document.createElement('li');
		item.textContent = `${model.display_name ?? model.slug} (${model.slug})`;
		document.getElementById('models').append(item);
	}
}
loadStatus().catch(() => {
	statusElement.textContent = 'The sign-in page could not reach the bridge.';
});

document.getElementById('select-model').addEventListener('click', async () => {
	try {
		const response = await fetch('/auth/model', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: document.getElementById('model').value }),
		});
		const value = await response.json();
		if (!response.ok) throw new Error(value.error?.message ?? 'The model could not be selected.');
		statusElement.textContent = `Connected. Selected model: ${value.model}.`;
	} catch (error) {
		statusElement.textContent = error.message;
	}
});
