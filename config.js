import { Regex } from '@companion-module/base'

export const configFields = [
	{
		type: 'dropdown',
		id: 'protocol',
		label: 'Protocol',
		width: 4,
		default: 'mqtt://',
		choices: [
			{ id: 'mqtt://', label: 'mqtt://' },
			{ id: 'mqtts://', label: 'mqtts://' },
			{ id: 'ws://', label: 'ws://' },
			{ id: 'wss://', label: 'wss://' },
		],
	},
	{
		type: 'textinput',
		id: 'broker_ip',
		width: 4,
		label: 'Broker IP',
		regex: Regex.IP,
	},
	{
		type: 'number',
		id: 'port',
		width: 4,
		label: 'Port',
		default: 1883,
		min: 1,
		max: 65535,
	},
	{
		type: 'textinput',
		id: 'user',
		width: 6,
		label: 'Username',
	},
	{
		type: 'textinput',
		id: 'password',
		width: 6,
		label: 'Password',
	},
]
