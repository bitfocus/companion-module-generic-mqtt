var instance_skel = require('../../instance_skel');
var mqtt = require("mqtt");
var match = require("mqtt-match");
var mqttClient;
var debug;
var log;

class instance extends instance_skel {
	constructor(system, id, config) {
		super(system, id, config);

		var self = this;

		self.system = system;
		self.mqtt_topic_subscriptions = new Map();

		self.actions(); // export actions

	}

	updateConfig(config) {
		var self = this;

		self.config = config;

		self.actions();
		self._initMqtt();
	}

	init() {
		var self = this;

		debug = self.debug;
		log = self.log;

		self._initMqtt();
		self._initFeedbackDefinitions();
		self._updateInstanceFeedbacks();

		// Watch for feedback delete so MQTT subscriptions can be updated.
		self.system.on('feedback_delete', function (page, bank, id) {
			debug('Feedback delete event received.');
			self._unsubscribeAll();
			self._clearInstanceVariables();
			self._updateInstanceFeedbacks();
		});


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
				callback: (feedback) => {
					debug('Feedback callback called');
					self._unsubscribeAll();
					self._clearInstanceVariables();

					self._addMqttFeedback(feedback)

					self._refreshMqttSubscriptions();
					self._updateInstanceVariables();
				}
			}
		});
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
		if (mqttClient && mqttClient.connected) {
			mqttClient.disconnect()
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
			case 'publish':
				const {retain, topic, qos, payload} = action.options;
				self._publishMessage(topic, payload, qos, retain);
		}
	}

	_addMqttFeedback(feedback, bank) {
		var self = this;

		debug("Adding MQTT feedback");
		debug(feedback);

		if(feedback.options.subscribeTopic === undefined || feedback.options.subscribeTopic === '') {
			debug('Skipping empty MQTT feedback topic.');
			return;
		}

		// TODO switch case feedback type if more are added since callback will be specific to the type

		var obj = {
			topic: feedback.options.subscribeTopic,
			options: feedback.options,
			callback: (variable, mqttMessage) => {
				debug(`Setting value for instance variable: ${variable}`);

				// TODO extract value from field if object path provided.

				// Update variable value for this feedback when message is received.
				self.setVariable(variable, mqttMessage)
			}
		};

		self.mqtt_topic_subscriptions.set(feedback.id, obj);

	}

	_initMqtt() {
		var self = this;

		mqttClient = mqtt.connect(self.config.protocol + self.config.broker_ip, {
			username: self.config.user,
			password: self.config.password
		});

		mqttClient.on('connect', () => {
			self.status(self.STATUS_OK)
		});

		mqttClient.on('error', error => {
			self.status(self.STATUS_ERROR, error)
		});

		mqttClient.on('offline', () => {
			self.status(self.STATUS_WARNING, 'Offline')
		});

		mqttClient.on('packetreceive', packet => {
			debug('MQTT', packet)
		});

		mqttClient.on('message', function(topic, message, packet) {
			self._handleMqttMessage(topic, message, packet)
		})
	}

	_publishMessage(topic, payload, qos, retain) {
		var self = this;

		debug('Sending MQTT message', [topic, payload]);

		self._reconnectMqtt();

		mqttClient.publish(topic, payload, {qos: qos, retain: retain})
	}

	_refreshMqttSubscriptions() {
		var self = this;

		debug('Refreshing MQTT subscriptions: ', self.mqtt_topic_subscriptions);

		self.mqtt_topic_subscriptions.forEach((obj, index) => {
			mqttClient.subscribe(obj.topic, (err) => {
				if (!err) {
					debug(`Successfully subscribed to topic: ${obj.topic}`)
					return;
				}

				debug(`Failed to subscribe to topic: ${obj.topic}. Error: ${err}`)
			})
		})
	}

	_reconnectMqtt() {
		var self = this;

		if (!mqttClient.connected) {
			mqttClient.reconnect();

			if (!mqttClient.connected) {
				self.status(self.STATUS_WARNING, 'Offline')
			}
		}
	}

	_handleMqttMessage(topic, message, packet) {
		var self = this;

		debug('MQTT message received:', {
			topic: topic,
			message: message.toString()
		});

		debug(self.mqtt_topic_subscriptions);

		// Match topic to correct subscriber
		var sub = self._getSubscriptionsByTopic(topic);

		sub.forEach(function(s) {
			debug('Matching subscription: ', s);
			s.callback(s.options.variable, message.toString());
		});
	}

	_getSubscriptionsByTopic(topic) {
		var self = this;

		return [...self.mqtt_topic_subscriptions.values()].filter((v) => {
			return match(topic, v.topic)
		});
	}

	_updateInstanceFeedbacks() {
		var self = this;

		self.system.emit('feedbacks_for_instance', self.id, function (feedbacks) {
			feedbacks.forEach((feedback) => {
				debug('Initializing existing MQTT feedbacks.');
				debug(feedback);

				self._unsubscribeAll();
				self._clearInstanceVariables();

				self._addMqttFeedback(feedback);

				self._refreshMqttSubscriptions();
				self._updateInstanceVariables();
			})
		})
	}

	_updateInstanceVariables() {
		var self = this;

		var vars = [...self.mqtt_topic_subscriptions.values()].map(function(sub) {

			return {
				label: `MQTT value from topic: ${sub.topic}`,
				name: sub.options.variable,
			}
		});

		debug('Refreshing variable definitions:', vars);
		self.setVariableDefinitions(vars)
	}

	_unsubscribeAll() {
		var self = this;

		// This is necessary to prevent orphaned subscriptions when a feedback is updated.

		self.mqtt_topic_subscriptions.forEach((obj, index) => {
			mqttClient.unsubscribe(obj.topic, (err) => {
				if (!err) {
					debug(`Successfully unsubscribed from topic: ${obj.topic}`)
					return;
				}

				debug(`Failed to unsubscribe from topic: ${obj.topic}. Error: ${err}`)
			})
		});
	}

	_clearInstanceVariables() {
		var self = this;
		self.setVariableDefinitions([]);
	}
}

exports = module.exports = instance;