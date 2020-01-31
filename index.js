var instance_skel = require('../../instance_skel');
var mqtt = require("mqtt");
var client;
var debug;
var log;

class instance extends instance_skel {
	constructor(system, id, config) {
		super(system, id, config);

		var self = this;

		self.actions(); // export actions
	}

	updateConfig(config) {
		var self = this;

		self.config = config;

		self.actions();
		self._connectMqtt()
	}

	init() {
		var self = this;

		debug = self.debug;
		log = self.log;

		self._connectMqtt()

	}

	config_fields() {
		var self = this;

		return [
			{
				type: 'dropdown',
				id: 'protocol',
				label: 'Protocol',
				width: 4,
				default: 1,
				choices: [
					{ id: 'mqtt://', label: 'mqtt://' },
					{ id: 'mqtts://', label: 'mqtts://' },
					{ id: 'ws://', label: 'ws://' },
					{ id: 'wss://', label: 'wss://'}
				]
			},
			{
				type: 'textinput',
				id: 'broker_ip',
				width: 4,
				label: 'Broker IP',
				regex: self.REGEX_IP
			},
			{
				type: 'number',
				id: 'port',
				width: 4,
				label: 'Port',
				regex: self.REGEX_PORT
			},
			{
				type: 'textinput',
				id: 'user',
				width: 6,
				label: 'Username'
			},
			{
				type: 'textinput',
				id: 'password',
				width: 6,
				label: 'Password'
			},
		];
	}

	destroy() {
		if(client && client.connected) {
			client.disconnect()
		}
	}

	actions(system) {
		var self = this;

		self.setActions({
			'publish': {
				label: 'Publish Message',
				options: [
					{
						type: 'textinput',
						label: 'Topic',
						id: 'topic',
						default: '',
						width: 12
					},
					{
						type: 'textinput',
						label: 'Payload',
						id: 'payload',
						default: '',
						width: 12
					},
					{
						type: 'number',
						label: 'QoS',
						id: 'qos',
						default: 0,
						width: 4
					},
					{
						type: 'checkbox',
						label: 'Retain?',
						id: 'retain',
						default: false,
						width: 4
					}
				]
			}
		})
	}

	action(action) {
		var self = this;

		switch (action.action) {
			case 'publish':
				const {retain, topic, qos, payload} = action.options;
				self._publishMessage(topic, payload, qos, retain);
		}
	}

	_connectMqtt() {
		var self = this;

		debug('MQTT protocol', self.config.protocol);

		client = mqtt.connect(self.config.protocol + self.config.broker_ip, {username: self.config.user, password: self.config.password})

		client.on('connect', function() {
			self.status(self.STATUS_OK)
		});

		client.on('error', function(error) {
			self.status(self.STATUS_ERROR, error)
		});

		client.on('offline', function() {
			self.status(self.STATUS_WARNING, 'Offline')
		});

		client.on('packetreceive', function(packet) {
			debug('MQTT', packet)
		})
	}

	_publishMessage(topic, payload, qos, retain) {
		var self = this;

		debug('Sending MQTT message', [topic, payload]);
		if (!client.connected) {
			self.status(self.STATUS_WARNING, 'Offline')
			self._connectMqtt()
		}

		client.publish(topic, payload, {qos: qos, retain: retain})
	}
}

exports = module.exports = instance;