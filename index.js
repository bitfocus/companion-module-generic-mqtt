var instance_skel = require('../../instance_skel');
var mqtt = require("mqtt");
var debounceFn = require('debounce-fn')

class instance extends instance_skel {

	constructor(system, id, config) {
		super(system, id, config);

		var self = this;

		self.mqtt_topic_subscriptions = new Map()
		self.mqtt_topic_value_cache = new Map()

		this.debounceUpdateInstanceVariables = debounceFn(this._updateInstanceVariables, {
			wait: 100,
			immediate: false
		})
	}

	updateConfig(config) {
		var self = this;

		self.config = config;

		self._initMqtt();
	}
	

	init() {
		var self = this;

		self.actions();
		self._initFeedbackDefinitions();
		self._initMqtt();
	}

	_resubscribeToTopics() {
		var self = this;

		// Unsubscribe from everything
		self.mqtt_topic_subscriptions.forEach((topic) => {
			self.mqttClient.unsubscribe(topic, (err) => {
				if (!err) {
					self.debug(`Successfully unsubscribed from topic: ${topic}`)
					return;
				}

				self.debug(`Failed to unsubscribe from topic: ${topic}. Error: ${err}`)
			})
		})
		self.mqtt_topic_subscriptions = new Map()
		self.mqtt_topic_value_cache = new Map()

		// And then subscribe
		self.subscribeFeedbacks()
	}

	_initFeedbackDefinitions() {
		var self = this;

		self.setFeedbackDefinitions({
			mqtt_variable: {
				label: 'Update variable with value from MQTT topic',
				description: 'Receive messages from the MQTT broker and set the value to a variable. Variables can be used on any button.',
				options: [
					{
						type: 'textinput',
						label: 'Topic',
						id: 'subscribeTopic',
						default: ''
					},
					{
						type: 'textinput',
						label: 'Variable',
						id: 'variable',
						default: ''
					}
				],
				callback: () => {
					// Nothing to do, as this feeds a variable
				},
				subscribe: (feedback) => {
					self._subscribeToTopic(feedback.options.subscribeTopic, feedback.id, 'mqtt_variable', {
						variableName: feedback.options.variable
					})
					self.debounceUpdateInstanceVariables()
				},
				unsubscribe: (feedback) => {
					self._unsubscribeToTopic(feedback.options.subscribeTopic, feedback.id)
					self.debounceUpdateInstanceVariables()
				}
			}
		});
	}

	_subscribeToTopic(topic, feedbackId, feedbackType, data) {
		const self = this

		const subscriptions = self.mqtt_topic_subscriptions.get(topic) || {}
		if (Object.keys(subscriptions).length === 0) {
			self.mqttClient.subscribe(topic, (err) => {
				if (!err) {
					self.debug(`Successfully subscribed to topic: ${topic}`)
					return;
				}

				self.debug(`Failed to subscribe to topic: ${topic}. Error: ${err}`)
			})
		}
		if (!subscriptions[feedbackId]) {
			subscriptions[feedbackId] = { ...data, type: feedbackType }
			self.mqtt_topic_subscriptions.set(topic, subscriptions)
		}
	}
	_unsubscribeToTopic(topic, feedbackId) {
		const self = this
		
		const subscriptions = self.mqtt_topic_subscriptions.get(topic) || {}
		if (Object.keys(subscriptions).length !== 0 && !subscriptions[feedbackId]) {
			delete subscriptions[feedbackId]
			self.mqtt_topic_subscriptions.set(topic, subscriptions)

			if (Object.keys(subscriptions).length === 0) {
				self.mqttClient.unsubscribe(topic, (err) => {
					if (self.mqtt_topic_value_cache.has(topic)) {
						// Ensure cached value is pruned
						self.mqtt_topic_value_cache.delete(topic)
					}

					if (!err) {
						self.debug(`Successfully unsubscribed from topic: ${topic}`)
						return;
					}
	
					self.debug(`Failed to unsubscribe from topic: ${topic}. Error: ${err}`)
				})
			}
		}
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
					{id: 'mqtt://', label: 'mqtt://'},
					{id: 'mqtts://', label: 'mqtts://'},
					{id: 'ws://', label: 'ws://'},
					{id: 'wss://', label: 'wss://'}
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
			}
		];
	}

	destroy() {
		var self = this;

		if (self.mqttClient && self.mqttClient.connected) {
			self.mqttClient.disconnect()
		}
	}

	actions() {
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
						width: 4,
						min: 0,
						max: 2
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
			case 'publish': {
				const {retain, topic, qos, payload} = action.options;
				self._publishMessage(topic, payload, qos, retain);
			}
		}
	}

	_initMqtt() {
		var self = this;

		self.mqttClient = mqtt.connect(self.config.protocol + self.config.broker_ip, {
			username: self.config.user,
			password: self.config.password
		});
		self._resubscribeToTopics()

		self.mqttClient.on('connect', () => {
			self.status(self.STATUS_OK)
		});

		self.mqttClient.on('error', error => {
			self.status(self.STATUS_ERROR, error)
		});

		self.mqttClient.on('offline', () => {
			self.status(self.STATUS_WARNING, 'Offline')
		});

		self.mqttClient.on('packetreceive', packet => {
			self.debug('MQTT', packet)
		});

		self.mqttClient.on('message', function(topic, message) {
			self._handleMqttMessage(topic, message.toString())
		})
	}

	_publishMessage(topic, payload, qos, retain) {
		var self = this;

		self.debug('Sending MQTT message', [topic, payload]);

		self._reconnectMqtt();

		self.mqttClient.publish(topic, payload, {qos: qos, retain: retain})
	}

	_reconnectMqtt() {
		var self = this;

		if (!self.mqttClient.connected) {
			self.mqttClient.reconnect();

			if (!self.mqttClient.connected) {
				self.status(self.STATUS_WARNING, 'Offline')
			}
		}
	}

	_handleMqttMessage(topic, message) {
		var self = this;

		self.debug('MQTT message received:', {
			topic: topic,
			message: message
		});

		const subscriptions = self.mqtt_topic_subscriptions.get(topic)
		if (subscriptions) {
			self.mqtt_topic_value_cache.set(message)

			const feedbacksToUpdate = Array.from(new Set(Object.values(subscriptions).map(s => s.type)))
			feedbacksToUpdate.forEach(type => {
				if (type === 'mqtt_variable') {
					const subs = Object.values(subscriptions).filter(t => t.type === type)
					subs.forEach(s => {
						self.setVariable(s.variableName, message)
					})
				} else {
					self.checkFeedbacks(type)
				}
			})
		}
	}

	_updateInstanceVariables() {
		var self = this;

		var vars = []

		self.mqtt_topic_subscriptions.forEach((uses, key) => {
			Object.values(uses).forEach(use => {
				if (use.type === 'mqtt_variable') {
					vars.push({
						label: `MQTT value from topic: ${key}`,
						name: use.variableName,
					})
				}
			})
		})

		self.debug('Refreshing variable definitions:', vars);
		self.setVariableDefinitions(vars)
	}

}

exports = module.exports = instance;