/** Tiny deterministic joke pool — pure data, no network. */
const JOKES = [
	"Why did the smart contract cross the road? To settle on the other side.",
	"I told my wallet a joke about gas fees. It didn't find it funny; it was drained.",
	"How many nodes does it take to change a light bulb? One, but the other 9,999 have to agree.",
	"Paywrap walks into a bar. Bartender: 402, payment required.",
	"Why don't payment channels tell secrets? They leak off-chain.",
] as const;

export const randomJoke = (): string => {
	const idx = Math.floor(Math.random() * JOKES.length);
	return JOKES[idx] ?? JOKES[0];
};
