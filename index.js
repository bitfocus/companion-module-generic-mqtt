import { combineRgb, InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import { configFields } from './config.js'
import { upgradeScripts } from './upgrade.js'
import mqtt from 'mqtt'
import debounceFn from 'debounce-fn'
import objectPath from 'object-path'

class GenericMqttInstance extends InstanceBase {
	constructor(system, id, config) {
		super(system, id, config)

		this.mqtt_topic_subscriptions = new Map()
		this.mqtt_topic_value_cache = new Map()

		this.debounceUpdateInstanceVariables = debounceFn(this._updateInstanceVariables, {
			wait: 100,
			immediate: false,
		})
	}

	configUpdated(config) {
		this.config = config

		this._initMqtt()
	}

	async init(config) {
		this.config = config

		this._initActionDefinitions()
		this._initFeedbackDefinitions()
		this._initMqtt()
	}

	getConfigFields() {
		return configFields
	}

	async destroy() {
		this._destroyMqtt()
	}

	_resubscribeToTopics() {
		// Unsubscribe from everything
		for (const topic of this.mqtt_topic_subscriptions.values()) {
			try {
				this.mqttClient.unsubscribe(topic, (err) => {
					if (!err) {
						this.log('debug', `Successfully unsubscribed from topic: ${topic}`)
						return
					}

					this.log('debug', `Failed to unsubscribe from topic: ${topic}. Error: ${err}`)
				})
			} catch (e) {
				// Ignore
			}
		}

		this.mqtt_topic_subscriptions = new Map()
		this.mqtt_topic_value_cache = new Map()

		// And then subscribe
		this.subscribeFeedbacks()
	}

	_initFeedbackDefinitions() {
		this.setFeedbackDefinitions({
			mqtt_variable: {
				type: 'advanced',
				name: 'Update variable with value from MQTT topic',
				description:
					'Receive messages from the MQTT broker and set the value to a variable. Variables can be used on any button.',
				options: [
					{
						type: 'textinput',
						label: 'Topic',
						id: 'subscribeTopic',
						default: '',
					},
					{
						type: 'textinput',
						label: 'JSON Path (Blank if not json)',
						id: 'subpath',
						default: '',
					},
					{
						type: 'textinput',
						label: 'Variable',
						id: 'variable',
						default: '',
					},
				],
				callback: () => {
					// Nothing to do, as this feeds a variable
				},
				subscribe: (feedback) => {
					const subData = {
						variableName: feedback.options.variable,
						subpath: feedback.options.subpath,
					}
					this._subscribeToTopic(feedback.options.subscribeTopic, feedback.id, 'mqtt_variable', subData)
					this.debounceUpdateInstanceVariables()

					// Update it if we have a cached value
					const message = this.mqtt_topic_value_cache.get(feedback.options.subscribeTopic)
					if (message !== undefined) {
						this._updateFeedbackVariables([[feedback.options.subscribeTopic, subData]])
					}
				},
				unsubscribe: (feedback) => {
					this._unsubscribeToTopic(feedback.options.subscribeTopic, feedback.id)
					this.debounceUpdateInstanceVariables()
				},
			},
			mqtt_value: {
				type: 'boolean',
				name: 'Change style from MQTT topic value',
				description: 'If the specified MQTT topic value matches this condition, change style of the bank.',
				defaultStyle: {
					color: combineRgb(0, 0, 0),
					bgcolor: combineRgb(0, 255, 0),
				},
				options: [
					{
						type: 'textinput',
						label: 'Topic',
						id: 'subscribeTopic',
						default: '',
					},
					{
						type: 'textinput',
						label: 'JSON Path (Blank if not json)',
						id: 'subpath',
						default: '',
					},
					{
						type: 'textinput',
						label: 'Value',
						id: 'value',
						default: '',
					},
					{
						type: 'dropdown',
						label: 'Comparison',
						id: 'comparison',
						default: 'eq',
						choices: [
							{ id: 'eq', label: '=' },
							{ id: 'ne', label: '!=' },
							{ id: 'lt', label: '<' },
							{ id: 'lte', label: '<=' },
							{ id: 'gt', label: '>' },
							{ id: 'gte', label: '>=' },
						],
					},
				],
				callback: (feedback) => {
					let value = this.mqtt_topic_value_cache.get(feedback.options.subscribeTopic)
					if (value !== undefined) {
						if (feedback.options.subpath) {
							value = objectPath.get(JSON.parse(value), feedback.options.subpath)
						}

						const targetValue = feedback.options.value
						const checks = {
							eq: value == targetValue,
							ne: value != targetValue,
							lt: value < targetValue,
							lte: value <= targetValue,
							gt: value > targetValue,
							gte: value >= targetValue,
						}
						return checks[feedback.options.comparison] || false
					}

					return false
				},
				subscribe: (feedback) => {
					this._subscribeToTopic(feedback.options.subscribeTopic, feedback.id, 'mqtt_value')
				},
				unsubscribe: (feedback) => {
					this._unsubscribeToTopic(feedback.options.subscribeTopic, feedback.id)
				},
			},
		})
	}

	_subscribeToTopic(topic, feedbackId, feedbackType, data) {
		const subscriptions = this.mqtt_topic_subscriptions.get(topic) || {}
		if (Object.keys(subscriptions).length === 0) {
			this.mqttClient.subscribe(topic, (err) => {
				if (!err) {
					this.log('debug', `Successfully subscribed to topic: ${topic}`)
					return
				}

				this.log('debug', `Failed to subscribe to topic: ${topic}. Error: ${err}`)
			})
		}

		if (!subscriptions[feedbackId]) {
			subscriptions[feedbackId] = { ...data, type: feedbackType }
			this.mqtt_topic_subscriptions.set(topic, subscriptions)
		}
	}
	_unsubscribeToTopic(topic, feedbackId) {
		const subscriptions = this.mqtt_topic_subscriptions.get(topic) || {}
		if (Object.keys(subscriptions).length !== 0 && subscriptions[feedbackId]) {
			delete subscriptions[feedbackId]
			this.mqtt_topic_subscriptions.set(topic, subscriptions)

			if (Object.keys(subscriptions).length === 0) {
				try {
					this.mqttClient.unsubscribe(topic, (err) => {
						if (this.mqtt_topic_value_cache.has(topic) && !this.mqtt_topic_subscriptions.has(topic)) {
							// Ensure cached value is pruned
							this.mqtt_topic_value_cache.delete(topic)
						}

						if (!err) {
							this.log('debug', `Successfully unsubscribed from topic: ${topic}`)
							return
						}

						this.log('debug', `Failed to unsubscribe from topic: ${topic}. Error: ${err}`)
					})
				} catch (e) {
					// Ignore
				}
			}
		}
	}

	_initActionDefinitions() {
		this.setActionDefinitions({
			publish: {
				name: 'Publish Message',
				options: [
					{
						type: 'textinput',
						label: 'Topic',
						id: 'topic',
						default: '',
						width: 12,
						useVariables: true,
					},
					{
						type: 'textinput',
						label: 'Payload',
						id: 'payload',
						default: '',
						width: 12,
						useVariables: true,
					},
					{
						type: 'number',
						label: 'QoS',
						id: 'qos',
						default: 0,
						width: 4,
						min: 0,
						max: 2,
					},
					{
						type: 'checkbox',
						label: 'Retain?',
						id: 'retain',
						default: false,
						width: 4,
					},
				],
				callback: async (action) => {
					let opt = action.options;

					let topic = await this.parseVariablesInString(opt.topic);
					let payload = await this.parseVariablesInString(opt.payload);
					let qos = opt.qos;
					let retain = opt.retain;

					this.log('debug', `Sending MQTT message ${topic}: ${payload}`)

					this.mqttClient.publish(topic, payload, { qos: qos, retain: retain })
				},
			},
		})
	}

	_destroyMqtt() {
		if (this.mqttClient !== undefined) {
			if (this.mqttClient.connected) {
				this.mqttClient.end()
			}
			delete this.mqttClient
		}
	}

	_initMqtt() {
		this._destroyMqtt()

		try {
			const brokerPort = isNaN(parseInt(this.config.port)) ? '' : `:${this.config.port}`
			const brokerUrl = `${this.config.protocol}${this.config.broker_ip}${brokerPort}`

			this.updateStatus(InstanceStatus.Connecting)

			const options = {
				username: this.config.user,
				password: this.config.password,
			}

			if (this.config.clientId) {
				options.clientId = this.config.clientId
			}

			this.mqttClient = mqtt.connect(brokerUrl, options)
			this._resubscribeToTopics()

			this.mqttClient.on('connect', () => {
				this.updateStatus(InstanceStatus.Ok)
			})

			this.mqttClient.on('error', (error) => {
				this.updateStatus(InstanceStatus.UnknownError, error.message || error.toString())

				this.log('error', error.toString())

				setTimeout(() => {
					this._initMqtt()
				}, 1000)
			})

			this.mqttClient.on('offline', () => {
				this.updateStatus(InstanceStatus.Disconnected)
			})

			// this.mqttClient.on('packetreceive', packet => {
			// 	this.debug('MQTT', packet)
			// });

			this.mqttClient.on('message', (topic, message) => {
				try {
					if (topic) {
						this._handleMqttMessage(topic, message ? message.toString() : '')
					}
				} catch (e) {
					this.log('error', `Handle message faaailed: ${e.toString()}`)
				}
			})
		} catch (e) {
			this.updateStatus(InstanceStatus.UnknownError, e.message || e.toString())
		}
	}

	_handleMqttMessage(topic, message) {
		// this.log('debug', 'MQTT message received:', {
		// 	topic: topic,
		// 	message: message,
		// })

		const subscriptions = this.mqtt_topic_subscriptions.get(topic)
		if (subscriptions) {
			this.mqtt_topic_value_cache.set(topic, message)

			const variablesToUpdate = []
			const feedbackIdsToUpdate = []

			for (const [id, data] of Object.entries(subscriptions)) {
				if (data.type === 'mqtt_variable') {
					variablesToUpdate.push([topic, data])
				} else {
					feedbackIdsToUpdate.push(id)
				}
			}

			this.checkFeedbacksById(...feedbackIdsToUpdate)
			this._updateFeedbackVariables(variablesToUpdate)
		}
	}

	_updateFeedbackVariables(variables) {
		const newValues = {}

		for (const [topic, data] of variables) {
			let msgValue = this.mqtt_topic_value_cache.get(topic)
			if (msgValue) {
				if (data.subpath) {
					msgValue = objectPath.get(JSON.parse(msgValue), data.subpath)
				}

				newValues[data.variableName] = typeof msgValue === 'object' ? JSON.stringify(msgValue) : msgValue
			}
		}

		this.setVariableValues(newValues)
	}

	_updateInstanceVariables() {
		const vars = []

		for (const [key, uses] of this.mqtt_topic_subscriptions.entries()) {
			Object.values(uses).forEach((use) => {
				if (use.type === 'mqtt_variable') {
					vars.push({
						name: `MQTT value from topic: ${key}`,
						variableId: use.variableName,
					})
				}
			})
		}

		this.log('debug', 'Refreshing variable definitions:', vars)
		this.setVariableDefinitions(vars)
	}
}

runEntrypoint(GenericMqttInstance, upgradeScripts)
