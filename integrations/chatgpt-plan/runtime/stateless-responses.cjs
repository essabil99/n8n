// Apply these settings before the SDK encodes conversation history.
module.exports = function statelessResponses(model, wrapLanguageModel) {
	return wrapLanguageModel({
		model,
		middleware: {
			specificationVersion: 'v4',
			transformParams: async ({ params }) => ({
				...params,
				providerOptions: {
					...params.providerOptions,
					openai: {
						...params.providerOptions?.openai,
						store: false,
						forceReasoning: true,
						include: ['reasoning.encrypted_content'],
					},
				},
			}),
		},
	});
};
